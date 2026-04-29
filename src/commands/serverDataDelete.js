/**
 * /server-data-delete — admin-only. Resets server-level config:
 *   • guild_personality (the bot's personality prompt for this server)
 *   • guild_channels    (channel routing for errors / metrics / notices)
 *
 * Does NOT touch:
 *   • guild_credits / credit_transactions / token_usage — accounting integrity.
 *   • Any user-personal data (reminders, conversations, audit).
 *
 * For a complete server purge, kick DiVA from the server. That triggers
 * the natural cleanup path. (Phase 2 may add a 30-day grace + auto-purge
 * on bot kick — for now, those rows persist until manual cleanup.)
 *
 * Two-step ✅/❌ confirmation flow with 60-second timeout.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } from 'discord.js';
import { countServerData, deleteServerData } from '../db/serverData.js';
import logger from '../utils/logger.js';

const CONFIRMATION_TIMEOUT_MS = 60_000;

export default async function serverDataDelete(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Manage Server to reset server data.', ephemeral: true });
    }

    const guildId = interaction.guild.id;
    const guildName = interaction.guild.name;
    const status = countServerData(guildId);

    if (!status.has_personality && !status.has_channel_config) {
        return interaction.reply({
            content: `\`${guildName}\` has no DiVA server-level config to reset (no personality prompt and no channel routing). Nothing to do.`,
            ephemeral: true,
        });
    }

    const confirmId = `server-data-delete-confirm-${guildId}-${Date.now()}`;
    const cancelId = `server-data-delete-cancel-${guildId}-${Date.now()}`;

    const lines = [
        `**Confirm server data reset for \`${guildName}\`**`,
        '',
        'You are about to reset the following server-level config:',
        '',
    ];
    if (status.has_personality) {
        lines.push('• `guild_personality` — clears DiVA\'s evolved personality prompt for this server (bot returns to base personality)');
    }
    if (status.has_channel_config) {
        lines.push('• `guild_channels` — clears channel routing (errors / weekly metrics / update notices revert to defaults)');
    }
    lines.push(
        '',
        '**Not affected by this command:**',
        '• Server credits and transaction history — accounting integrity, only the bot operator can adjust those',
        '• Token usage records — accounting integrity',
        '• Any individual user\'s reminders, conversations, or admin-tool audit rows — those are user-personal data and only the user can delete via `/data-delete`',
        '',
        'For a complete server purge, kick DiVA from the server.',
        '',
        '**This action cannot be undone.** Confirmation expires in 60 seconds.',
    );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Reset server config').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({
        content: lines.join('\n'),
        components: [row],
        ephemeral: true,
        fetchReply: true,
    });

    const filter = (i) => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId);
    const collector = reply.createMessageComponentCollector({ filter, time: CONFIRMATION_TIMEOUT_MS, max: 1 });

    collector.on('collect', async (i) => {
        if (i.customId === cancelId) {
            await i.update({ content: 'Cancelled. No server data was reset.', components: [] });
            return;
        }

        try {
            const result = deleteServerData(guildId);
            logger.info('Server data reset', {
                guildId, requestedBy: interaction.user.id, result,
            });

            const summaryAfter = [
                `✅ **Server config reset for \`${guildName}\`.**`,
                '',
                `• Personality prompt: ${result.guild_personality_deleted > 0 ? 'cleared' : 'no row to clear'}`,
                `• Channel routing: ${result.guild_channels_deleted > 0 ? 'cleared' : 'no row to clear'}`,
                '',
                'DiVA will rebuild personality fresh as members chat. Channel routing reverts to defaults — set new ones via `/channel set` if you want them back.',
            ].join('\n');

            await i.update({ content: summaryAfter, components: [] });
        } catch (err) {
            logger.error('Server data delete failed', { guildId, error: err.message, stack: err.stack });
            await i.update({
                content: 'Something went wrong during the reset. **No partial state should have been written** (transactional). Open a GitHub issue or DM the operator if it keeps happening.',
                components: [],
            });
        }
    });

    collector.on('end', async (collected) => {
        if (collected.size === 0) {
            try {
                await interaction.editReply({
                    content: 'Confirmation timed out. No server data was reset.',
                    components: [],
                });
            } catch {
                // Already edited (e.g. by the cancel branch)
            }
        }
    });
}
