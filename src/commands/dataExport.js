/**
 * /data-export — produce a JSON file of every database row tied to the
 * calling user, across every guild DiVA is in. Delivered as an ephemeral
 * message attachment so other server members never see the contents.
 *
 * GDPR / CCPA / PIPEDA right-of-access compliance.
 *
 * Rate-limited at 1 export per user per hour (in-memory; resets on restart,
 * which is acceptable — the export is cheap to generate and Discord's
 * file-upload pipeline is the real cost).
 */

import { AttachmentBuilder } from 'discord.js';
import { assembleUserDataExport, countUserData } from '../db/userDataExport.js';
import logger from '../utils/logger.js';

// userId → epoch ms of last export. Cleared on bot restart (acceptable).
const lastExportAt = new Map();
const EXPORT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Discord's file upload cap for non-Nitro is 25 MB. Even a heavy user is
// unlikely to exceed a few hundred KB given retention windows, but we
// guard against it and degrade gracefully.
const DISCORD_FILE_BYTE_LIMIT = 25 * 1024 * 1024;

export default async function dataExport(interaction) {
    const userId = interaction.user.id;

    // — Rate limit —
    const last = lastExportAt.get(userId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
        const remainingMin = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 60_000);
        return interaction.reply({
            content: `You can request a data export once per hour. Try again in about ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`,
            ephemeral: true,
        });
    }

    // Defer reply — assembling rows + serializing JSON is fast, but file
    // attachments through Discord can introduce latency.
    await interaction.deferReply({ ephemeral: true });

    try {
        const counts = countUserData(userId);
        const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

        // Quick "you have nothing" path so we don't ship an empty file.
        if (totalRows === 0) {
            return interaction.editReply({
                content: 'DiVA has no data linked to your Discord account. Nothing to export.',
            });
        }

        const exportObj = assembleUserDataExport(userId);
        const json = JSON.stringify(exportObj, null, 2);
        const buffer = Buffer.from(json, 'utf-8');

        if (buffer.byteLength > DISCORD_FILE_BYTE_LIMIT) {
            // Vanishingly unlikely path. Log it so we can investigate if it ever happens.
            logger.warn('Data export exceeds Discord file cap', {
                userId, byteLength: buffer.byteLength,
            });
            return interaction.editReply({
                content: `Your export is too large to attach to a Discord message (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB > 25 MB limit). Please open a GitHub issue or DM the operator to receive your export by another channel.`,
            });
        }

        const filename = `diva-data-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
        const attachment = new AttachmentBuilder(buffer, { name: filename });

        const summary = [
            '**Your DiVA data export is ready.**',
            '',
            `• \`user_settings\`: ${counts.user_settings} row${counts.user_settings === 1 ? '' : 's'}`,
            `• \`reminders\`: ${counts.reminders} row${counts.reminders === 1 ? '' : 's'}`,
            `• \`conversations\`: ${counts.conversations} row${counts.conversations === 1 ? '' : 's'} _(14-day retention)_`,
            `• \`token_usage\`: ${counts.token_usage} row${counts.token_usage === 1 ? '' : 's'}`,
            `• \`admin_tool_audit\`: ${counts.admin_tool_audit} row${counts.admin_tool_audit === 1 ? '' : 's'} _(90-day retention)_`,
            counts.undo_actions > 0 ? `• \`undo_actions\`: ${counts.undo_actions} row${counts.undo_actions === 1 ? '' : 's'} _(usually empty)_` : null,
            '',
            'This export covers every DiVA-managed server you participate in. Server-level data (server credits, server personality, channel routing) is not included — that\'s available to server admins via `/server-data-export`.',
            '',
            'Privacy policy: <https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/blob/main/PRIVACY.md>',
        ].filter(Boolean).join('\n');

        lastExportAt.set(userId, Date.now());
        logger.info('User data export delivered', {
            userId,
            byteLength: buffer.byteLength,
            counts,
        });

        return interaction.editReply({
            content: summary,
            files: [attachment],
        });
    } catch (err) {
        logger.error('Data export failed', { userId, error: err.message, stack: err.stack });
        return interaction.editReply({
            content: 'Something went wrong assembling your export. The error has been recorded — please open a GitHub issue or DM the operator if it keeps happening.',
        });
    }
}
