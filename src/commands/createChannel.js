import { ChannelType } from 'discord.js';
import { hasPermission } from '../utils/permissions.js';
import logger from '../utils/logger.js';

export default async function createChannel(interaction) {
    if (!hasPermission(interaction.member, 'ManageChannels')) {
        return interaction.reply({ content: 'You need the **Manage Channels** permission.', ephemeral: true });
    }

    const name = interaction.options.getString('name');
    const category = interaction.options.getChannel('category');

    const channel = await interaction.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category?.id || null,
    });

    logger.info('Channel created', {
        guild: interaction.guild.id,
        user: interaction.user.id,
        channel: channel.id,
        name,
    });

    await interaction.reply({ content: `Channel created: ${channel}`, ephemeral: true });
}
