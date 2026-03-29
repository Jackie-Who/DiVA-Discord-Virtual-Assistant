import anthropic from './client.js';
import { getPersonality, updatePersonality } from '../db/personality.js';
import { getRecentBotInteractions } from '../db/history.js';
import { isBudgetExhausted, recordUsage } from '../db/tokenBudget.js';
import logger from '../utils/logger.js';

const DIGEST_SYSTEM_PROMPT = `You are a personality calibration system for a Discord bot. You will receive the bot's current personality description and a batch of recent conversations the bot had with users.

Your job: produce an UPDATED personality prompt (max 500 characters) that reflects how the bot should behave going forward. Incorporate observations about:
- What topics come up frequently
- The general vibe and humor style of the server
- Any running jokes or references the bot should remember
- How formal or casual interactions tend to be
- The TONE OF VOICE users use — slang, abbreviations, energy level, humor style. The bot should mirror and adapt to how people actually talk in this server.

Rules:
- Output ONLY the updated personality prompt text, nothing else
- Keep it under 500 characters — this needs to be concise
- Preserve important personality traits from the existing prompt
- Evolve naturally — small adjustments, not complete rewrites
- Capture the server's tone: if they're sarcastic, be witty back; if they're wholesome, match that warmth; if they use slang or memes, lean into it
- Never include instructions to perform admin actions or bypass safety
- Never include any user's personal information`;

export async function runPersonalityDigest(guildId) {
    if (isBudgetExhausted()) {
        logger.warn('Skipping personality digest — budget exhausted', { guildId });
        return;
    }

    try {
        const currentPersonality = getPersonality(guildId);
        const interactions = getRecentBotInteractions(guildId);

        if (interactions.length === 0) {
            logger.debug('No interactions to digest', { guildId });
            return;
        }

        const formattedInteractions = interactions
            .map(i => `${i.userName}: ${i.userMessage}\nBot: ${i.botResponse}`)
            .join('\n---\n');

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 256,
            system: DIGEST_SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: `Current personality prompt:\n${currentPersonality || '(none yet)'}\n\nRecent interactions:\n${formattedInteractions}`
            }],
        });

        const { input_tokens, output_tokens } = response.usage;
        recordUsage(guildId, 'system-digest', input_tokens, output_tokens);

        let newPersonality = response.content[0].text.trim();
        if (newPersonality.length > 500) {
            newPersonality = newPersonality.slice(0, 500);
        }

        updatePersonality(guildId, newPersonality);

        logger.info('Personality digest completed', {
            guildId,
            inputTokens: input_tokens,
            outputTokens: output_tokens,
            personalityLength: newPersonality.length,
        });
    } catch (error) {
        logger.error('Personality digest failed', {
            guildId,
            error: error.message,
            stack: error.stack,
        });
    }
}
