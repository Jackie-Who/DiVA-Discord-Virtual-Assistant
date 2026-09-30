/**
 * /server-data-export — admin-only. Produces a JSON file of every
 * server-level row DiVA holds for this guild.
 *
 * SCOPE: server-level only. Individual users' reminders, conversations,
 * and admin_tool_audit rows are NOT included — those are user-personal
 * data, accessible to each user via /data-export. Token usage is
 * aggregated by day to give admins spend visibility without exposing
 * per-message content.
 *
 * Delivered as an ephemeral message attachment. Rate-limited at 1 per
 * guild per hour to prevent abuse.
 */

import { AttachmentBuilder, PermissionsBitField } from 'discord.js';
import { assembleServerDataExport } from '../db/serverData.js';
import logger from '../utils/logger.js';

const lastExportAt = new Map(); // guildId → epoch ms
const EXPORT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DISCORD_FILE_BYTE_LIMIT = 25 * 1024 * 1024;

export default async function serverDataExport(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Manage Server to export server data.', ephemeral: true });
    }

    const guildId = interaction.guild.id;
    const last = lastExportAt.get(guildId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
        const remainingMin = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 60_000);
        return interaction.reply({
            content: `A server data export was generated for this server recently. Try again in about ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`,
            ephemeral: true,
        });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const exportObj = assembleServerDataExport(guildId);
        const json = JSON.stringify(exportObj, null, 2);
        const buffer = Buffer.from(json, 'utf-8');

        if (buffer.byteLength > DISCORD_FILE_BYTE_LIMIT) {
            logger.warn('Server data export exceeds Discord file cap', {
                guildId, byteLength: buffer.byteLength,
            });
            return interaction.editReply({
                content: `The export is too large for a Discord attachment (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB > 25 MB limit). Open a GitHub issue or DM the operator to receive it another way.`,
            });
        }

        const filename = `diva-server-export-${guildId}-${new Date().toISOString().slice(0, 10)}.json`;
        const attachment = new AttachmentBuilder(buffer, { name: filename });

        const tx = exportObj.credit_transactions?.count ?? 0;
        const days = exportObj.token_usage_daily?.count ?? 0;
        const summary = [
            `**Server data export for \`${interaction.guild.name}\`**`,
            '',
            `• Credits: ${exportObj.guild_credits ? 'included' : 'no balance row yet'}`,
            `• Credit transactions: ${tx} entries`,
            `• Channel routing: ${exportObj.guild_channels ? 'included' : 'no config'}`,
            `• Personality prompt: ${exportObj.guild_personality ? 'included' : 'no prompt yet'}`,
            `• Token usage: aggregated per day across ${days} day${days === 1 ? '' : 's'}`,
            '',
            'User-personal data (reminders, conversations, admin-tool audit) is excluded from this export. Individual users can run `/data-export` to retrieve their own data.',
            '',
            'Privacy policy: <https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/blob/main/PRIVACY.md>',
        ].join('\n');

        lastExportAt.set(guildId, Date.now());
        logger.info('Server data export delivered', {
            guildId, byteLength: buffer.byteLength, requestedBy: interaction.user.id,
        });

        return interaction.editReply({ content: summary, files: [attachment] });
    } catch (err) {
        logger.error('Server data export failed', { guildId, error: err.message, stack: err.stack });
        return interaction.editReply({
            content: 'Something went wrong assembling the export. The error has been recorded — please open a GitHub issue or DM the operator if it keeps happening.',
        });
    }
}
