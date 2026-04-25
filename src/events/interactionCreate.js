import logger from '../utils/logger.js';
import budget from '../commands/budget.js';
import personality from '../commands/personality.js';

// Note: as of v1.2 we removed /create-channel, /delete-channel, /ban, /kick, /purge —
// Discord's native UI handles those better, and the bot's natural-language admin
// tools cover the same actions when needed.
//
// New v1.2 commands (credits, timezone, reminder, secretary, channel, notices) are
// registered in register.js and added to the dispatch table below as each one ships.

const commands = {
    budget,
    personality,
};

export default function interactionCreate(client) {
    client.on('interactionCreate', async (interaction) => {
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
