import { hasPermission, canModerate, botCanModerate } from '../utils/permissions.js';
import logger from '../utils/logger.js';

export default async function ban(interaction) {
    if (!hasPermission(interaction.member, 'BanMembers')) {
        return interaction.reply({ content: 'You need the **Ban Members** permission.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) {
        return interaction.reply({ content: 'Could not find that user in this server.', ephemeral: true });
    }

    if (!canModerate(interaction.member, target)) {
        return interaction.reply({ content: 'You cannot ban someone with an equal or higher role.', ephemeral: true });
    }

    if (!botCanModerate(interaction.guild, target)) {
        return interaction.reply({ content: 'I cannot ban this user — their role is higher than mine.', ephemeral: true });
    }

    // Attempt to DM the user
    try {
        await user.send(`You have been banned from **${interaction.guild.name}**. Reason: ${reason}`);
    } catch {
        // DMs may be closed
    }

    await interaction.guild.members.ban(user, { reason });

    logger.info('User banned', {
        guild: interaction.guild.id,
        moderator: interaction.user.id,
        target: user.id,
        reason,
    });

    await interaction.reply({ content: `**${user.tag}** has been banned. Reason: ${reason}`, ephemeral: true });
}
