/**
 * /admin-audit              — show the last 25 admin-tool executions in this server
 * /admin-audit user:@member — same, but filtered to one member
 *
 * Requires Manage Server (or Administrator). Useful for investigating "who
 * just deleted that channel" or "how did this role get assigned" without
 * digging through Discord's audit log (DiVA's audit row also includes the
 * tool name and the structured input, which Discord's audit log doesn't).
 *
 * Retention: 90 days. Older entries are pruned by the hourly sweep in
 * src/index.js.
 */

import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { listRecentAuditEntries } from '../db/adminAudit.js';

const DISPLAY_LIMIT = 25;

function formatEntry(entry) {
    const ts = `<t:${Math.floor(new Date(entry.created_at + 'Z').getTime() / 1000)}:R>`;
    const status = entry.success ? '✅' : '❌';
    const tool = `\`${entry.tool_name}\``;
    const user = `<@${entry.user_id}>`;
    let detail = '';
    if (entry.success && entry.input_json) {
        // Show a compact preview of the input (already capped at 500 chars in DB).
        const preview = entry.input_json.length > 80
            ? entry.input_json.slice(0, 80) + '…'
            : entry.input_json;
        detail = ` — \`${preview}\``;
    } else if (!entry.success && entry.error_message) {
        detail = ` — _${entry.error_message.slice(0, 100)}_`;
    }
    return `${status} ${ts} ${user} ${tool}${detail}`;
}

export default async function adminAudit(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Manage Server to view the admin audit log.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const entries = listRecentAuditEntries(interaction.guild.id, {
        userId: targetUser?.id,
        limit: DISPLAY_LIMIT,
    });

    if (entries.length === 0) {
        const empty = targetUser
            ? `No admin-tool activity recorded for ${targetUser} in this server (within the 90-day window).`
            : 'No admin-tool activity recorded for this server yet (within the 90-day window).';
        return interaction.reply({ content: empty, ephemeral: true });
    }

    const lines = entries.map(formatEntry);
    const description = lines.join('\n');

    const titleSuffix = targetUser ? ` — ${targetUser.displayName ?? targetUser.username}` : '';
    const embed = new EmbedBuilder()
        .setTitle(`Admin tool audit${titleSuffix}`)
        .setDescription(description.slice(0, 4000)) // Discord's hard cap is 4096
        .setFooter({
            text: `Showing ${entries.length} most recent ${entries.length === 1 ? 'entry' : 'entries'} · 90-day retention`,
        })
        .setColor(0x5865F2);

    return interaction.reply({ embeds: [embed], ephemeral: true });
}
