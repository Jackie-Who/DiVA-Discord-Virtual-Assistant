import { chat } from '../ai/chat.js';
import { isRateLimited } from '../utils/rateLimiter.js';
import { isGuildOutOfCredits, tryClaimOofNotice } from '../db/credits.js';
import { attachAiSuggestionButtons } from '../utils/aiSuggestionButton.js';
import logger from '../utils/logger.js';
import { notifyError } from '../utils/errorNotifier.js';

export default function messageCreate(client) {
    client.on('messageCreate', async (message) => {
        // Ignore bots
        if (message.author.bot) return;

        // Ignore @everyone and @here
        if (message.mentions.everyone) return;

        // Only trigger on a direct @mention of the bot (not role mentions or other users)
        const isMentioned = message.mentions.has(client.user) &&
            (message.content.includes(`<@${client.user.id}>`) || message.content.includes(`<@!${client.user.id}>`));
        let isReplyToBot = false;

        if (message.reference && !isMentioned) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId);
                isReplyToBot = referenced.author.id === client.user.id;
            } catch {
                // Referenced message may be deleted
            }
        }

        if (!isMentioned && !isReplyToBot) return;

        // Rate limiting
        if (isRateLimited(message.author.id, message.channel.id)) {
            try {
                await message.react('\u23F3');
            } catch {
                // Reaction may fail if missing permissions
            }
            return;
        }

        // Out-of-credits check (per-server lifetime credits, owner-managed guilds bypass)
        if (isGuildOutOfCredits(message.guild.id)) {
            // Post the OOF notice at most once per 24h per guild — don't spam.
            const shouldNotify = tryClaimOofNotice(message.guild.id);
            if (shouldNotify) {
                try {
                    await message.reply(
                        "💤 This server is out of credits. An admin can top up with `/credits` (or contact the bot owner). " +
                        "I'll be back as soon as credits are added!"
                    );
                } catch (error) {
                    logger.error('Failed to send out-of-credits message', { error: error.message });
                }
            } else {
                // Silent acknowledge so the user knows we saw it but won't reply.
                try { await message.react('\u{1F4A4}'); } catch { /* missing perms */ }
            }
            return;
        }

        try {
            await message.channel.sendTyping();
            const { text: response, aiSuggestions = [] } = await chat(message, client);

            // Discord has a 2000 character limit per message
            // Split into as many messages as needed, max 6 to prevent spam
            const MAX_CHARS = 2000;
            const MAX_MESSAGES = 6;

            let firstReply;
            if (response.length <= MAX_CHARS) {
                firstReply = await message.reply(response);
            } else {
                const chunks = [];
                let remaining = response;
                while (remaining.length > 0 && chunks.length < MAX_MESSAGES) {
                    if (remaining.length <= MAX_CHARS) {
                        chunks.push(remaining);
                        remaining = '';
                    } else {
                        // Find a good split point — prefer code block boundaries, then newlines, then spaces
                        let splitAt = -1;

                        // Try to avoid splitting inside code blocks
                        const codeBlockEnd = remaining.lastIndexOf('\n```', MAX_CHARS);
                        if (codeBlockEnd > MAX_CHARS * 0.3) {
                            splitAt = codeBlockEnd + 4; // After the closing ```
                        }

                        if (splitAt < MAX_CHARS * 0.3) {
                            splitAt = remaining.lastIndexOf('\n\n', MAX_CHARS);
                        }
                        if (splitAt < MAX_CHARS * 0.3) {
                            splitAt = remaining.lastIndexOf('\n', MAX_CHARS);
                        }
                        if (splitAt < MAX_CHARS * 0.3) {
                            splitAt = remaining.lastIndexOf(' ', MAX_CHARS);
                        }
                        if (splitAt < MAX_CHARS * 0.3) {
                            splitAt = MAX_CHARS;
                        }

                        chunks.push(remaining.slice(0, splitAt));
                        remaining = remaining.slice(splitAt).trimStart();
                    }
                }
                if (remaining.length > 0) {
                    chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, MAX_CHARS - 30) + '\n\n*(response truncated)*';
                }
                firstReply = await message.reply(chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                    await message.channel.send(chunks[i]);
                }
            }

            // If a reminder tool produced an AI title suggestion, attach a
            // "✨ Use suggested" button to the bot's first reply. Fire-and-forget
            // — listener lives for 5 minutes; only the original user can click.
            if (aiSuggestions.length > 0 && firstReply) {
                attachAiSuggestionButtons(firstReply, aiSuggestions, message.author.id)
                    .catch(err => logger.error('AI suggestion button error', { error: err.message }));
            }
        } catch (error) {
            logger.error('Message handler error', {
                guild: message.guild?.id,
                channel: message.channel.id,
                user: message.author.id,
                error: error.message,
                stack: error.stack,
            });

            await notifyError({
                title: 'Message Handler Error',
                error,
                guildId: message.guild?.id,
                context: {
                    guild: message.guild?.id,
                    channel: message.channel.id,
                    user: `${message.author.username} (${message.author.id})`,
                    message: message.content?.slice(0, 200),
                },
            });

            try {
                await message.reply("Something went wrong, try again in a bit.");
            } catch {
                // If replying fails, nothing we can do
            }
        }
    });
}
