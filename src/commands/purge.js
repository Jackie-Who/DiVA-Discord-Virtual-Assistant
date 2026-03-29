import { hasPermission } from '../utils/permissions.js';
import logger from '../utils/logger.js';

export default async function purge(interaction) {
    if (!hasPermission(interaction.member, 'ManageMessages')) {
        return interaction.reply({ content: 'You need the **Manage Messages** permission.', ephemeral: true });
    }

    const count = interaction.options.getInteger('count');

    const deleted = await interaction.channel.bulkDelete(count, true);

    logger.info('Messages purged', {
        guild: interaction.guild.id,
        user: interaction.user.id,
        channel: interaction.channel.id,
        requested: count,
        deleted: deleted.size,
    });

    await interaction.reply({
        content: `Deleted **${deleted.size}** messages.${deleted.size < count ? ` (${count - deleted.size} were older than 14 days and skipped)` : ''}`,
        ephemeral: true,
    });
}
