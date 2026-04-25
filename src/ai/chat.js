import anthropic from './client.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { saveMessage, getRecentHistory, getChannelMemory } from '../db/history.js';
import { getPersonality, incrementInteractionCount, shouldRunDigest } from '../db/personality.js';
import { getUserSettings } from '../db/userSettings.js';
import { isGuildOutOfCredits, isGuildInSavingMode, getGuildSpendPercent, recordUsage } from '../db/tokenBudget.js';
import { runPersonalityDigest } from './personality.js';
import { ADMIN_TOOL_DEFINITIONS, executeAdminTool, isReadOnlyTool, formatToolForConfirmation, recordUndoableAction, getUndoableActions, clearUndoActions, executeUndo } from './adminTools.js';
import { USER_TOOL_DEFINITIONS, executeUserTool, isUserTool, isReadOnlyUserTool, formatUserToolForConfirmation, shouldSkipConfirmation } from './userTools.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { notifyError } from '../utils/errorNotifier.js';
import { checkAdminRateLimit, recordAdminToolCall } from '../utils/adminRateLimiter.js';

const CONFIRMATION_TIMEOUT_MS = 60_000; // 60 seconds to confirm
const ADMIN_MAX_TOKENS = 4096; // Higher token limit for admin tool requests to allow multi-step plans

// Model routing — Haiku for simple messages, Sonnet for complex
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const COMPLEX_INDICATORS = /\b(explain|analyze|compare|how does|why does|write|code|debug|review|create|help me|build|implement|summarize|describe|what happened|tell me about|remind me|reminder|every day|every week|tomorrow|schedule)\b/i;
const SIMPLE_MAX_LENGTH = 200; // Messages under this length with no complex indicators use Haiku

const SAVING_MODE_WARNING = "\n\n\u26A0\uFE0F *Budget is above 85% for the month — web search and image analysis are disabled to conserve tokens.*";
const MAX_TOOL_ROUNDS = 3;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * Choose the right model based on message complexity.
 * Sonnet for: admin requests, images, long/complex messages, web search likely needed.
 * Haiku for: short, simple, conversational messages.
 */
function chooseModel({ text, hasImages, isAdmin, hasTools }) {
    // Always use Sonnet for admin tool requests and image analysis
    if (isAdmin || hasImages) return MODEL_SONNET;

    // Long messages or complex questions → Sonnet
    if (text.length > SIMPLE_MAX_LENGTH || COMPLEX_INDICATORS.test(text)) return MODEL_SONNET;

    // Short, simple, conversational → Haiku
    return MODEL_HAIKU;
}

function getImageAttachments(message) {
    const images = [];
    for (const attachment of message.attachments.values()) {
        const ext = attachment.name?.split('.').pop()?.toLowerCase();
        if (ext && IMAGE_EXTENSIONS.has(ext) && attachment.url) {
            images.push({
                type: 'image',
                source: {
                    type: 'url',
                    url: attachment.url,
                },
            });
        }
    }
    return images;
}

function buildUserContent(text, imageBlocks) {
    if (imageBlocks.length === 0) {
        return text;
    }
    const content = [...imageBlocks];
    if (text) {
        content.push({ type: 'text', text });
    }
    return content;
}

function extractResponseText(response) {
    const textParts = [];
    for (const block of response.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        }
    }
    return textParts.join('\n\n');
}

function stripMentions(text) {
    return text.replace(/<@!?\d+>/g, '').trim();
}

function isAdmin(member) {
    if (!member) return false;
    return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

/**
 * Walk the reply chain upward, collecting messages and images from ANY user.
 * Returns { messages: [...], images: [...] }
 *   - messages: array of { role, content } for the Anthropic API
 *   - images: array of image blocks found in the chain (for vision)
 */
async function buildReplyChain(message, client, maxMessages = 3) {
    const chain = [];
    const chainImages = [];
    let current = message;

    while (current.reference && chain.length < maxMessages) {
        try {
            const referenced = await current.channel.messages.fetch(current.reference.messageId);

            // Collect images from this message in the chain
            for (const attachment of referenced.attachments.values()) {
                const ext = attachment.name?.split('.').pop()?.toLowerCase();
                if (ext && IMAGE_EXTENSIONS.has(ext) && attachment.url) {
                    chainImages.push({
                        type: 'image',
                        source: { type: 'url', url: attachment.url },
                    });
                }
            }

            const text = stripMentions(referenced.content);

            if (referenced.author.id === client.user.id) {
                // Bot's own message
                chain.push({ role: 'assistant', content: text || '(empty)' });
            } else {
                // Any user (the requesting user OR a third party)
                const authorName = referenced.author.displayName || referenced.author.username;
                const hasImages = referenced.attachments.some(a => {
                    const ext = a.name?.split('.').pop()?.toLowerCase();
                    return ext && IMAGE_EXTENSIONS.has(ext);
                });

                let content = text || '';
                if (hasImages && !content) {
                    content = '(shared an image)';
                } else if (hasImages) {
                    content += ' (with an attached image)';
                }

                chain.push({
                    role: 'user',
                    content: `[${authorName}]: ${content || '(empty)'}`,
                });
            }

            current = referenced;
        } catch {
            break;
        }
    }

    chain.reverse();
    return { messages: chain, images: chainImages };
}

/**
 * Send a confirmation message with buttons for admin OR user tool actions.
 * Both go through the same UX. The formatter is dispatched per block based on
 * whether the tool is an admin or user tool.
 * Returns { confirmed: boolean, confirmMsgId: string | null }
 */
async function requestToolConfirmation(message, toolBlocks) {
    const userId = message.author.id;
    const actionLines = toolBlocks.map(b => {
        if (isUserTool(b.name)) return formatUserToolForConfirmation(b.name, b.input, userId);
        return formatToolForConfirmation(b.name, b.input);
    });
    const description = actionLines.length === 1
        ? `I'll perform the following action:\n\n${actionLines[0]}`
        : `I'll perform the following **${actionLines.length} actions**:\n\n${actionLines.join('\n')}`;

    const ts = Date.now();
    const confirmId = `confirm_${message.id}_${ts}`;
    const cancelId = `cancel_${message.id}_${ts}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(confirmId)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId(cancelId)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
    );

    const confirmMsg = await message.reply({
        content: description + `\n\n*Waiting for confirmation... (expires <t:${Math.floor((ts + CONFIRMATION_TIMEOUT_MS) / 1000)}:R>)*`,
        components: [row],
    });

    try {
        const interaction = await confirmMsg.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === message.author.id && (i.customId === confirmId || i.customId === cancelId),
            time: CONFIRMATION_TIMEOUT_MS,
        });

        const disabledRow = ActionRowBuilder.from(row).setComponents(
            row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
        );

        if (interaction.customId === confirmId) {
            await interaction.update({
                content: description + '\n\n✅ **Confirmed** — executing now...',
                components: [disabledRow],
            });
            return { confirmed: true, confirmMsgId: confirmMsg.id, confirmMsg, description };
        } else {
            await interaction.update({
                content: description + '\n\n❌ **Cancelled** — no changes were made.',
                components: [disabledRow],
            });
            return { confirmed: false, confirmMsgId: null };
        }
    } catch {
        const disabledRow = ActionRowBuilder.from(row).setComponents(
            row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
        );
        try {
            await confirmMsg.edit({
                content: description + '\n\n⏰ **Timed out** — no changes were made.',
                components: [disabledRow],
            });
        } catch { /* message deleted */ }
        return { confirmed: false, confirmMsgId: null };
    }
}

/**
 * Add an Undo button to the confirmation message after successful execution.
 * Listens for the undo click for 5 minutes.
 */
async function attachUndoButton(confirmMsg, description, guildId, userId, confirmMsgId, guild) {
    const undoId = `undo_${confirmMsgId}_${Date.now()}`;
    const UNDO_TIMEOUT = 5 * 60_000; // 5 minutes to undo

    const undoRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(undoId)
            .setLabel('Undo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('↩️'),
    );

    try {
        await confirmMsg.edit({
            content: description + '\n\n✅ **Done** — actions completed successfully.',
            components: [undoRow],
        });

        const interaction = await confirmMsg.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === userId && i.customId === undoId,
            time: UNDO_TIMEOUT,
        });

        // User clicked undo
        const actions = getUndoableActions(guildId, userId, confirmMsgId);
        if (!actions || actions.length === 0) {
            await interaction.update({ content: description + '\n\n⚠️ Nothing to undo.', components: [] });
            return;
        }

        const results = [];
        for (const action of actions) {
            const result = await executeUndo(guild, userId, action);
            results.push(`${result.success ? '✅' : '❌'} ${result.message}`);
        }

        clearUndoActions(guildId, userId, confirmMsgId);
        await interaction.update({
            content: description + `\n\n↩️ **Undo complete:**\n${results.join('\n')}`,
            components: [],
        });

        logger.info('Admin undo executed', { guild: guildId, user: userId, undone: actions.length });
    } catch {
        // Timeout — remove the undo button
        try {
            await confirmMsg.edit({
                content: description + '\n\n✅ **Done** — actions completed successfully.',
                components: [],
            });
        } catch { /* message deleted */ }
        clearUndoActions(guildId, userId, confirmMsgId);
    }
}

export async function chat(message, client) {
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.displayName || message.author.username;
    const guildName = message.guild.name;
    const memberIsAdmin = isAdmin(message.member);

    // Out-of-credits is handled in messageCreate.js (with the 24h notice cooldown).
    // chat() is only called when the guild still has credits.

    let userContent = stripMentions(message.content);

    // Inject spend percentage if the user asks about usage/budget/tokens
    const budgetKeywords = /\b(usage|budget|token|limit|spending|cost|how much|remaining|left)\b/i;
    if (budgetKeywords.test(userContent)) {
        const pct = getGuildSpendPercent(guildId).toFixed(1);
        userContent += `\n\n[System: This server has used ${pct}% of its credits.]`;
    }

    const savingMode = isGuildInSavingMode(guildId);
    const imageBlocks = savingMode ? [] : getImageAttachments(message);

    // Build reply chain context (includes images from chain)
    const isReply = !!message.reference;
    const replyChain = isReply ? await buildReplyChain(message, client) : { messages: [], images: [] };

    // Use reply chain if available, otherwise pull recent DB history for this user+channel
    const history = replyChain.messages.length > 0
        ? replyChain.messages
        : getRecentHistory(guildId, channelId, userId).map(row => ({ role: row.role, content: row.content }));

    // Merge images: chain images + current message images (skip all in saving mode)
    const allImages = savingMode ? [] : [...replyChain.images, ...imageBlocks];
    const hasAnyImages = allImages.length > 0 || message.attachments.size > 0 || replyChain.images.length > 0;

    if (!userContent && allImages.length === 0) {
        return savingMode && hasAnyImages
            ? "I can see you shared an image, but image analysis is disabled right now to conserve my monthly budget." + SAVING_MODE_WARNING
            : "Hey! Did you mean to say something?";
    }

    const personalityPrompt = getPersonality(guildId);

    // Build channel memory context (last 5 conversations in this channel)
    const channelMemory = getChannelMemory(guildId, channelId, 5);
    let channelMemoryText = '';
    if (channelMemory.length > 0) {
        const lines = channelMemory.map(m => `${m.userName}: ${m.userMessage}\nYou: ${m.botResponse}`);
        channelMemoryText = `\n\nRecent conversations in this channel:\n${lines.join('\n---\n')}\n\nUse this context if relevant, but don't reference it unprompted.`;
    }

    // User context for the reminder tools (timezone + delivery prefs)
    const userSettings = getUserSettings(userId);

    const systemPromptText = buildSystemPrompt({
        userName,
        guildName,
        personalityPrompt,
        isAdmin: memberIsAdmin,
        userTimezone: userSettings.timezone,
        userHasDeliveryPrefs: !!userSettings.deliveryMode,
    }) + channelMemoryText;

    const currentContent = buildUserContent(
        userContent || (allImages.length > 0 ? '(shared an image)' : ''),
        allImages
    );

    const messages = [
        ...history,
        { role: 'user', content: currentContent },
    ];

    // Build tools list
    const tools = [];

    if (!savingMode) {
        tools.push({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 2,
        });
    }

    // User tools (reminders) are available to EVERYONE.
    tools.push(...USER_TOOL_DEFINITIONS);

    // Admin tools layered on top for admins.
    if (memberIsAdmin) {
        tools.push(...ADMIN_TOOL_DEFINITIONS);
    }

    try {
        // Use higher max_tokens for admin requests to allow multi-step tool plans
        const effectiveMaxTokens = memberIsAdmin ? ADMIN_MAX_TOKENS : config.maxResponseTokens;

        // Route to cheaper model for simple messages
        const selectedModel = chooseModel({
            text: userContent,
            hasImages: allImages.length > 0,
            isAdmin: memberIsAdmin,
            hasTools: tools.length > 1, // more than just web_search
        });

        const apiParams = {
            model: selectedModel,
            max_tokens: effectiveMaxTokens,
            system: [
                {
                    type: 'text',
                    text: systemPromptText,
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages,
        };

        if (tools.length > 0) {
            apiParams.tools = tools;
        }

        let response = await anthropic.messages.create(apiParams);
        let { input_tokens, output_tokens } = response.usage;
        let totalInput = input_tokens;
        let totalOutput = output_tokens;

        // Tool use loop — handle admin tool calls with confirmation
        let rounds = 0;
        const undoButtonPromises = []; // fire-and-forget undo listeners
        // Per-turn safeguard: once a write tool fires (or cancels), reject further
        // write tools in the same conversation so Claude can't accidentally double-fire.
        let writesExecutedThisTurn = false;

        while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
            rounds++;

            const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
            // Strip web_search (server-side, no executor needed) — keep everything else for our routing
            const customBlocks = toolUseBlocks.filter(b => b.name !== 'web_search');

            // Per-round debug — tells us exactly what Claude tried to do each round
            if (customBlocks.length > 0) {
                logger.debug('Tool round', {
                    round: rounds,
                    user: userId,
                    blocks: customBlocks.map(b => ({ name: b.name, input_preview: JSON.stringify(b.input).slice(0, 200) })),
                    writesExecutedThisTurn,
                });
            }

            if (customBlocks.length === 0) break;

            // Split by tool category
            const adminBlocks = customBlocks.filter(b => !isUserTool(b.name));
            const userBlocks = customBlocks.filter(b => isUserTool(b.name));

            // If a non-admin somehow triggered an admin tool block, refuse politely
            if (adminBlocks.length > 0 && !memberIsAdmin) {
                messages.push({ role: 'assistant', content: response.content });
                messages.push({ role: 'user', content: adminBlocks.map(b => ({
                    type: 'tool_result',
                    tool_use_id: b.id,
                    content: 'That action requires server admin permissions. The user is not an admin.',
                    is_error: true,
                })).concat(userBlocks.map(b => ({
                    type: 'tool_result',
                    tool_use_id: b.id,
                    content: 'Skipped — combined call had admin tools the user cannot use.',
                    is_error: true,
                }))) });
                break;
            }

            // Apply admin rate limit only when admin tools were called
            if (adminBlocks.length > 0) {
                const rateCheck = checkAdminRateLimit(guildId);
                if (!rateCheck.allowed) {
                    const retrySeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
                    messages.push({ role: 'assistant', content: response.content });
                    messages.push({ role: 'user', content: customBlocks.map(b => ({
                        type: 'tool_result',
                        tool_use_id: b.id,
                        content: `Rate limited — too many admin actions. Try again in ${retrySeconds} seconds.`,
                        is_error: true,
                    })) });
                    break;
                }
            }

            // Separate read-only from write across both categories.
            // User tools have a third bucket: "auto-execute" (e.g., set_timezone,
            // short one-shot reminders <24h away) which run without a confirmation card.
            const adminReadOnly = adminBlocks.filter(b => isReadOnlyTool(b.name));
            const adminWrite = adminBlocks.filter(b => !isReadOnlyTool(b.name));

            const userReadOnly = userBlocks.filter(b => isReadOnlyUserTool(b.name));
            const userWriteAll = userBlocks.filter(b => !isReadOnlyUserTool(b.name));
            const userAutoExec = userWriteAll.filter(b => shouldSkipConfirmation(b.name, b.input, userId));
            const userWrite = userWriteAll.filter(b => !shouldSkipConfirmation(b.name, b.input, userId));

            const writeBlocks = [...adminWrite, ...userWrite];
            const toolResults = [];

            // Execute read-only tools immediately
            for (const toolUse of adminReadOnly) {
                const result = await executeAdminTool(toolUse.name, toolUse.input, message.guild, userId);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: result.message,
                });
                recordAdminToolCall(guildId);
            }
            for (const toolUse of userReadOnly) {
                const result = await executeUserTool(toolUse.name, toolUse.input, message, userId);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: result.message,
                });
            }
            // Auto-execute user-write tools that don't need confirmation (set_timezone, short reminders)
            for (const toolUse of userAutoExec) {
                const result = await executeUserTool(toolUse.name, toolUse.input, message, userId);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: result.message,
                });
                writesExecutedThisTurn = true; // counts as a write — prevents double-firing
            }

            // Write tools need confirmation (single combined card if mixed admin + user).
            // Safeguard: if a write was already executed this turn, refuse new ones to
            // prevent Claude from accidentally double-firing reminders/admin actions.
            if (writeBlocks.length > 0 && writesExecutedThisTurn) {
                logger.warn('Skipping duplicate write tools this turn', {
                    user: userId,
                    blocks: writeBlocks.map(b => b.name),
                });
                for (const toolUse of writeBlocks) {
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: 'A write action was already completed this turn. Respond to the user with text instead — do not call this tool again.',
                        is_error: true,
                    });
                }
            } else if (writeBlocks.length > 0) {
                const { confirmed, confirmMsgId, confirmMsg: cMsg, description } = await requestToolConfirmation(message, writeBlocks);
                writesExecutedThisTurn = true; // counts even on cancel — don't re-prompt

                if (confirmed) {
                    let hasUndoableActions = false;

                    for (const toolUse of writeBlocks) {
                        let result;
                        if (isUserTool(toolUse.name)) {
                            result = await executeUserTool(toolUse.name, toolUse.input, message, userId);
                        } else {
                            result = await executeAdminTool(toolUse.name, toolUse.input, message.guild, userId);
                            recordAdminToolCall(guildId);

                            // Only admin tools have undo metadata
                            if (result.undo) {
                                recordUndoableAction(guildId, userId, confirmMsgId, result.undo);
                                hasUndoableActions = true;
                            }
                            if (result.undoMulti) {
                                for (const u of result.undoMulti) {
                                    recordUndoableAction(guildId, userId, confirmMsgId, u);
                                }
                                hasUndoableActions = true;
                            }
                        }

                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: result.message,
                        });
                    }

                    // Attach undo button (fire-and-forget) — only for admin actions
                    if (hasUndoableActions && cMsg) {
                        undoButtonPromises.push(
                            attachUndoButton(cMsg, description, guildId, userId, confirmMsgId, message.guild)
                                .catch(err => logger.error('Undo button error', { error: err.message }))
                        );
                    }
                } else {
                    // User cancelled or timed out. Push tool_results so Claude can wrap up
                    // with text, but the writesExecutedThisTurn flag now prevents retries.
                    for (const toolUse of writeBlocks) {
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: 'The user did not confirm this action. Acknowledge briefly in text — do NOT call this tool again with similar input.',
                        });
                    }
                }
            }

            if (toolResults.length === 0) break;

            // Send tool results back to get the final response
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: toolResults });

            // Re-send typing indicator between rounds
            await message.channel.sendTyping();

            response = await anthropic.messages.create(apiParams);
            totalInput += response.usage.input_tokens;
            totalOutput += response.usage.output_tokens;
        }

        recordUsage(guildId, userId, totalInput, totalOutput, selectedModel);

        let responseText = extractResponseText(response);

        if (savingMode) {
            responseText += SAVING_MODE_WARNING;
        }

        // Save to DB for the personality digest system
        saveMessage(guildId, channelId, userId, userName, 'user', userContent || '(shared an image)');
        saveMessage(guildId, channelId, userId, userName, 'assistant', responseText);

        // Check if personality digest should run
        const count = incrementInteractionCount(guildId);
        if (shouldRunDigest(guildId)) {
            runPersonalityDigest(guildId).catch(err => {
                logger.error('Background digest failed', { error: err.message });
            });
        }

        logger.info('Chat response sent', {
            guild: guildId,
            channel: channelId,
            user: userId,
            model: selectedModel,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            hasImages: allImages.length > 0,
            replyChainLength: history.length,
            channelMemorySize: channelMemory.length,
            toolRounds: rounds,
            isAdmin: memberIsAdmin,
        });

        return responseText;
    } catch (error) {
        logger.error('Anthropic API error', {
            guild: guildId,
            channel: channelId,
            user: userId,
            error: error.message,
            stack: error.stack,
        });

        await notifyError({
            title: 'Anthropic API Error',
            error,
            guildId,
            context: { guild: guildId, channel: channelId, user: userId, status: error.status },
        });

        if (error.status === 429) {
            return "I need a quick breather, try again in a sec \u{1F605}";
        }
        if (error.status >= 500) {
            return "Something went wrong on my end, try again in a minute";
        }
        return "Oops, something went wrong. Try again?";
    }
}
