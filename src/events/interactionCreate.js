import logger from '../utils/logger.js';
import budget from '../commands/budget.js';
import credits from '../commands/credits.js';
import channel from '../commands/channels.js';
import notices from '../commands/notices.js';
import timezone from '../commands/timezone.js';
import reminder from '../commands/reminder.js';
import secretary from '../commands/secretary.js';
import personality from '../commands/personality.js';
import { handlePreFireButton } from '../utils/reminderScheduler.js';

// Note: as of v1.2 we removed /create-channel, /delete-channel, /ban, /kick, /purge —
// Discord's native UI handles those better, and the bot's natural-language admin
// tools cover the same actions when needed.

const commands = {
    budget,
    credits,
    channel,
    notices,
    timezone,
    reminder,
    secretary,
    personality,
};

export default function interactionCreate(client) {
    client.on('interactionCreate', async (interaction) => {
        // Pre-fire reminder buttons (Snooze / Dismiss). Routed globally so they
        // survive bot restarts — the message-component collector pattern doesn't
        // work for the 1-hour pre-fire window.
        if (interaction.isButton() && interaction.customId.startsWith('prefire_')) {
            try {
                await handlePreFireButton(interaction);
            } catch (error) {
                logger.error('Pre-fire button error', {
                    customId: interaction.customId,
                    user: interaction.user.id,
                    error: error.message,
                    stack: error.stack,
                });
                if (!interaction.replied && !interaction.deferred) {
                    try { await interaction.reply({ content: 'Something went wrong handling that button.', ephemeral: true }); } catch {}
                }
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const handler = commands[interaction.commandName];
        if (!handler) return;

        try {
            await handler(interaction);
        } catch (error) {
            logger.error('Command error', {
                command: interaction.commandName,
                guild: interaction.guild?.id,
                user: interaction.user.id,
                error: error.message,
                stack: error.stack,
            });

            const reply = { content: 'Something went wrong executing that command.', ephemeral: true };
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(reply);
                } else {
                    await interaction.reply(reply);
                }
            } catch {
                // Nothing we can do
            }
        }
    });
}
