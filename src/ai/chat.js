import anthropic from './client.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { saveMessage } from '../db/history.js';
import { getPersonality, incrementInteractionCount, shouldRunDigest } from '../db/personality.js';
import { isBudgetExhausted, isInSavingMode, getBudgetPercent, recordUsage } from '../db/tokenBudget.js';
import { runPersonalityDigest } from './personality.js';
import { ADMIN_TOOL_DEFINITIONS, executeAdminTool, isReadOnlyTool, formatToolForConfirmation } from './adminTools.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { notifyError } from '../utils/errorNotifier.js';

const CONFIRMATION_TIMEOUT_MS = 60_000; // 60 seconds to confirm

const BUDGET_EXHAUSTED_MESSAGE = "I've used up my thinking budget for this month. I'll be back on the 1st! \u{1F4A4}";
const SAVING_MODE_WARNING = "\n\n\u26A0\uFE0F *Budget is above 85% for the month — web search and image analysis are disabled to conserve tokens.*";
const MAX_TOOL_ROUNDS = 3;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

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
 * Send a confirmation message with buttons for admin tool actions.
 * Returns true if confirmed, false if cancelled or timed out.
 */
async function requestAdminConfirmation(message, toolBlocks) {
    // Format the proposed actions
    const actionLines = toolBlocks.map(b => formatToolForConfirmation(b.name, b.input));
    const description = actionLines.length === 1
        ? `I'll perform the following action:\n\n${actionLines[0]}`
        : `I'll perform the following **${actionLines.length} actions**:\n\n${actionLines.join('\n')}`;

    const confirmId = `confirm_${message.id}_${Date.now()}`;
    const cancelId = `cancel_${message.id}_${Date.now()}`;

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
        content: description + `\n\n*Waiting for confirmation... (expires <t:${Math.floor((Date.now() + CONFIRMATION_TIMEOUT_MS) / 1000)}:R>)*`,
        components: [row],
    });

    try {
        const interaction = await confirmMsg.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => {
                // Only the original admin who triggered the command can confirm
                return i.user.id === message.author.id &&
                    (i.customId === confirmId || i.customId === cancelId);
            },
            time: CONFIRMATION_TIMEOUT_MS,
        });

        // Disable buttons after click
        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(confirmId)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(cancelId)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
                .setDisabled(true),
        );

        if (interaction.customId === confirmId) {
            await interaction.update({
                content: description + '\n\n✅ **Confirmed** — executing now...',
                components: [disabledRow],
            });
            return true;
        } else {
            await interaction.update({
                content: description + '\n\n❌ **Cancelled** — no changes were made.',
                components: [disabledRow],
            });
            return false;
        }
    } catch (err) {
        // Timeout — no interaction received
        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(confirmId)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(cancelId)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
                .setDisabled(true),
        );

        try {
            await confirmMsg.edit({
                content: description + '\n\n⏰ **Timed out** — no changes were made.',
                components: [disabledRow],
            });
        } catch {
            // Message may have been deleted
        }

        return false;
    }
}

export async function chat(message, client) {
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.displayName || message.author.username;
    const guildName = message.guild.name;
    const memberIsAdmin = isAdmin(message.member);

    if (isBudgetExhausted()) {
        return BUDGET_EXHAUSTED_MESSAGE;
    }

    let userContent = stripMentions(message.content);

    // Inject budget percentage if the user asks about usage/budget/tokens
    const budgetKeywords = /\b(usage|budget|token|limit|spending|cost|how much|remaining|left)\b/i;
    if (budgetKeywords.test(userContent)) {
        const pct = getBudgetPercent().toFixed(1);
        userContent += `\n\n[System: Current monthly budget usage is ${pct}% of total capacity.]`;
    }

    const savingMode = isInSavingMode();
    const imageBlocks = savingMode ? [] : getImageAttachments(message);

    // Build reply chain context (includes images from chain)
    const isReply = !!message.reference;
    const replyChain = isReply ? await buildReplyChain(message, client) : { messages: [], images: [] };
    const history = replyChain.messages;

    // Merge images: chain images + current message images (skip all in saving mode)
    const allImages = savingMode ? [] : [...replyChain.images, ...imageBlocks];
    const hasAnyImages = allImages.length > 0 || message.attachments.size > 0 || replyChain.images.length > 0;

    if (!userContent && allImages.length === 0) {
        return savingMode && hasAnyImages
            ? "I can see you shared an image, but image analysis is disabled right now to conserve my monthly budget." + SAVING_MODE_WARNING
            : "Hey! Did you mean to say something?";
    }

    const personalityPrompt = getPersonality(guildId);
    const systemPromptText = buildSystemPrompt({ userName, guildName, personalityPrompt, isAdmin: memberIsAdmin });

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

    if (memberIsAdmin) {
        tools.push(...ADMIN_TOOL_DEFINITIONS);
    }

    try {
        const apiParams = {
            model: 'claude-sonnet-4-6',
            max_tokens: config.maxResponseTokens,
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
        while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
            rounds++;

            const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
            const adminToolBlocks = toolUseBlocks.filter(b => b.name !== 'web_search');

            if (adminToolBlocks.length === 0) break;

            // Separate read-only tools (no confirmation needed) from write tools
            const readOnlyBlocks = adminToolBlocks.filter(b => isReadOnlyTool(b.name));
            const writeBlocks = adminToolBlocks.filter(b => !isReadOnlyTool(b.name));

            const toolResults = [];

            // Execute read-only tools immediately (list_channels, list_roles)
            for (const toolUse of readOnlyBlocks) {
                const result = await executeAdminTool(toolUse.name, toolUse.input, message.guild, userId);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: result.message,
                });
            }

            // Write tools need confirmation
            if (writeBlocks.length > 0) {
                const confirmed = await requestAdminConfirmation(message, writeBlocks);

                if (confirmed) {
                    for (const toolUse of writeBlocks) {
                        const result = await executeAdminTool(toolUse.name, toolUse.input, message.guild, userId);
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: result.message,
                        });
                    }
                } else {
                    // User cancelled — return cancellation results
                    for (const toolUse of writeBlocks) {
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: 'Action cancelled by user.',
                        });
                    }
                }
            }

            if (toolResults.length === 0) break;

            // Send tool results back to get the final response
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: toolResults });

            response = await anthropic.messages.create(apiParams);
            totalInput += response.usage.input_tokens;
            totalOutput += response.usage.output_tokens;
        }

        recordUsage(guildId, userId, totalInput, totalOutput);

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
            inputTokens: totalInput,
            outputTokens: totalOutput,
            hasImages: allImages.length > 0,
            replyChainLength: history.length,
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
