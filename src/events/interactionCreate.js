import logger from '../utils/logger.js';
import createChannel from '../commands/createChannel.js';
import deleteChannel from '../commands/deleteChannel.js';
import ban from '../commands/ban.js';
import kick from '../commands/kick.js';
import purge from '../commands/purge.js';
import budget from '../commands/budget.js';

const commands = {
    'create-channel': createChannel,
    'delete-channel': deleteChannel,
    ban,
    kick,
    purge,
    budget,
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
