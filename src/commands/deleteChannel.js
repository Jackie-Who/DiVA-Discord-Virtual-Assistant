import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { hasPermission } from '../utils/permissions.js';
import logger from '../utils/logger.js';

export default async function deleteChannel(interaction) {
    if (!hasPermission(interaction.member, 'ManageChannels')) {
        return interaction.reply({ content: 'You need the **Manage Channels** permission.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm-delete').setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel-delete').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const response = await interaction.reply({
        content: `Are you sure you want to delete **#${channel.name}**?`,
        components: [row],
        ephemeral: true,
    });

    try {
        const confirmation = await response.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: i => i.user.id === interaction.user.id,
            time: 15_000,
        });

        if (confirmation.customId === 'confirm-delete') {
            await channel.delete();

            logger.info('Channel deleted', {
                guild: interaction.guild.id,
                user: interaction.user.id,
                channelName: channel.name,
            });

            await confirmation.update({ content: `Channel **#${channel.name}** deleted.`, components: [] });
        } else {
            await confirmation.update({ content: 'Cancelled.', components: [] });
        }
    } catch {
        await interaction.editReply({ content: 'Timed out — deletion cancelled.', components: [] });
    }
}
