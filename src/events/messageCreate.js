import { chat } from '../ai/chat.js';
import { isRateLimited } from '../utils/rateLimiter.js';
import { isBudgetExhausted } from '../db/tokenBudget.js';
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

        // Budget check
        if (isBudgetExhausted()) {
            try {
                await message.reply("I've used up my thinking budget for this month. I'll be back on the 1st! \u{1F4A4}");
            } catch (error) {
                logger.error('Failed to send budget message', { error: error.message });
            }
            return;
        }

        try {
            await message.channel.sendTyping();
            const response = await chat(message, client);

            // Discord has a 2000 character limit per message, max 3 messages total
            const MAX_CHARS = 2000;
            const MAX_MESSAGES = 3;

            if (response.length <= MAX_CHARS) {
                await message.reply(response);
            } else {
                // Split on newlines or spaces to avoid cutting mid-word
                const chunks = [];
                let remaining = response;
                while (remaining.length > 0 && chunks.length < MAX_MESSAGES) {
                    if (remaining.length <= MAX_CHARS) {
                        chunks.push(remaining);
                        remaining = '';
                    } else {
                        // Find a good split point (newline or space near the limit)
                        let splitAt = remaining.lastIndexOf('\n', MAX_CHARS);
                        if (splitAt < MAX_CHARS * 0.5) splitAt = remaining.lastIndexOf(' ', MAX_CHARS);
                        if (splitAt < MAX_CHARS * 0.5) splitAt = MAX_CHARS;
                        chunks.push(remaining.slice(0, splitAt));
                        remaining = remaining.slice(splitAt).trimStart();
                    }
                }
                if (remaining.length > 0) {
                    // Truncate with indicator if we hit the message cap
                    chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, MAX_CHARS - 30) + '\n\n*(response truncated)*';
                }
                await message.reply(chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                    await message.channel.send(chunks[i]);
                }
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
