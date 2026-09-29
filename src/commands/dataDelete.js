/**
 * /data-delete — wipe the calling user's data within THIS server only.
 *
 * Per-server scope (not cross-guild) — running this in Server A leaves
 * Server B untouched. To clean up multiple servers, run the command in
 * each one.
 *
 * Cross-server settings (timezone, secretary preferences) are NOT
 * affected — those are user-keyed, not guild-keyed. Use /timezone or
 * /secretary clear if you want to reset those too.
 *
 * Hard-deletes: reminders, conversations, undo_actions.
 * Anonymizes:   token_usage, admin_tool_audit (so server billing accounting
 *               and abuse forensics still work, but linkage to your user
 *               account is severed).
 *
 * Two-step ✅/❌ confirmation flow with 60-second timeout.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { countUserDataInGuild, deleteUserDataInGuild } from '../db/userDataDelete.js';
import logger from '../utils/logger.js';

const CONFIRMATION_TIMEOUT_MS = 60_000;

export default async function dataDelete(interaction) {
    if (!interaction.guild) {
        return interaction.reply({
            content: 'This command only works inside a server. To delete data from a specific server, run /data-delete from inside that server.',
            ephemeral: true,
        });
    }

    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const guildName = interaction.guild.name;

    const counts = countUserDataInGuild(userId, guildId);
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

    if (totalRows === 0) {
        return interaction.reply({
            content: `DiVA holds no data linked to your Discord account in **${guildName}**. Nothing to delete.`,
            ephemeral: true,
        });
    }

    const confirmId = `data-delete-confirm-${userId}-${Date.now()}`;
    const cancelId = `data-delete-cancel-${userId}-${Date.now()}`;

    const summary = [
        `**Confirm data deletion in \`${guildName}\`**`,
        '',
        'You are about to remove DiVA-held data linked to your account in **this server only**:',
        '',
        `• \`reminders\`: **${counts.reminders}** row${counts.reminders === 1 ? '' : 's'} — _hard deleted_`,
        `• \`conversations\`: **${counts.conversations}** row${counts.conversations === 1 ? '' : 's'} — _hard deleted_`,
        `• \`undo_actions\`: **${counts.undo_actions}** row${counts.undo_actions === 1 ? '' : 's'} — _hard deleted_`,
        `• \`token_usage\`: **${counts.token_usage}** row${counts.token_usage === 1 ? '' : 's'} — _anonymized_ (cost stays in server billing, not linked to you)`,
        `• \`admin_tool_audit\`: **${counts.admin_tool_audit}** row${counts.admin_tool_audit === 1 ? '' : 's'} — _anonymized_ (server admins keep abuse-investigation history, your linkage is severed)`,
        counts.role_selectors > 0 ? `• \`role_selectors\`: **${counts.role_selectors}** you created — _authorship anonymized_ (the selectors stay live for the server)` : null,
        '',
        '**Not affected by this command:**',
        '• Your timezone, secretary preferences, and delivery channel — these are cross-server. Use `/timezone` or `/secretary clear` if you want those gone too.',
        '• Your data in any **other** server DiVA is in. Run `/data-delete` separately in each one.',
        '',
        '**This action cannot be undone.** Confirmation expires in 60 seconds.',
    ].filter(line => line !== null).join('\n');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Delete my data').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({
        content: summary,
        components: [row],
        ephemeral: true,
        fetchReply: true,
    });

    const filter = (i) => i.user.id === userId && (i.customId === confirmId || i.customId === cancelId);
    const collector = reply.createMessageComponentCollector({ filter, time: CONFIRMATION_TIMEOUT_MS, max: 1 });

    collector.on('collect', async (i) => {
        if (i.customId === cancelId) {
            await i.update({ content: 'Cancelled. No data was deleted.', components: [] });
            return;
        }

        // Confirmed — execute the delete.
        try {
            const result = deleteUserDataInGuild(userId, guildId);
            logger.info('User data deleted (per-server)', { userId, guildId, result });

            const summaryAfter = [
                `✅ **Data deleted in \`${guildName}\`.**`,
                '',
                `• Reminders: ${result.reminders_deleted} deleted`,
                `• Conversations: ${result.conversations_deleted} deleted`,
                `• Undo actions: ${result.undo_actions_deleted} deleted`,
                `• Token usage: ${result.token_usage_anonymized} anonymized`,
                `• Admin tool audit: ${result.admin_tool_audit_anonymized} anonymized`,
                result.role_selectors_anonymized > 0 ? `• Role selectors you created: ${result.role_selectors_anonymized} anonymized (still live)` : null,
                '',
                'Your timezone and secretary preferences were not touched (they\'re cross-server). Use `/timezone` or `/secretary clear` if you want to reset those too.',
            ].filter(line => line !== null).join('\n');

            await i.update({ content: summaryAfter, components: [] });
        } catch (err) {
            logger.error('User data deletion failed', { userId, guildId, error: err.message, stack: err.stack });
            await i.update({
                content: 'Something went wrong during the deletion. **No partial state should have been written** (the deletion runs in a single transaction). The error has been recorded — please open a GitHub issue or DM the operator if it keeps happening.',
                components: [],
            });
        }
    });

    collector.on('end', async (collected) => {
        if (collected.size === 0) {
            try {
                await interaction.editReply({
                    content: 'Confirmation timed out. No data was deleted. Run `/data-delete` again if you still want to proceed.',
                    components: [],
                });
            } catch {
                // Reply may have been edited already (e.g. if the user cancelled and then we hit end-of-collector).
            }
        }
    });
}
