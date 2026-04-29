/**
 * Server-level data export + delete helpers, used by the admin-only
 * `/server-data-export` and `/server-data-delete` slash commands.
 *
 * SCOPE
 * -----
 * STRICTLY server-level. User-personal data (individual reminders,
 * conversations, admin_tool_audit rows) is NOT included in either flow,
 * even though it lives within the guild — those are the user's data, not
 * the server's, and admins should not be able to dump or delete them in
 * bulk via a single command.
 *
 * EXPORT
 * ------
 *   guild_credits        : current balance + lifetime totals
 *   credit_transactions  : full ledger
 *   guild_channels       : channel routing config (errors / metrics / notices)
 *   guild_personality    : the personality prompt itself
 *   token_usage_summary  : aggregate per-day spend (no per-user, no per-message content)
 *
 * DELETE
 * ------
 *   guild_personality    : reset
 *   guild_channels       : reset
 *
 *   guild_credits / credit_transactions / token_usage : NEVER deletable by
 *   server admins — accounting integrity. Only the bot operator can adjust
 *   these. The natural full-purge is to kick DiVA from the server.
 */

import { getDb } from './init.js';

/**
 * Assemble the export object for a server. Returned object is suitable for
 * JSON.stringify and attaching to an ephemeral admin reply.
 */
export function assembleServerDataExport(guildId) {
    const db = getDb();

    const guildCredits = db.prepare(`
        SELECT * FROM guild_credits WHERE guild_id = ?
    `).get(guildId) || null;

    const creditTransactions = db.prepare(`
        SELECT id, kind, amount_usd, actor_user_id, note, created_at
        FROM credit_transactions
        WHERE guild_id = ?
        ORDER BY created_at DESC
    `).all(guildId);

    const guildChannels = db.prepare(`
        SELECT * FROM guild_channels WHERE guild_id = ?
    `).get(guildId) || null;

    const guildPersonality = db.prepare(`
        SELECT * FROM guild_personality WHERE guild_id = ?
    `).get(guildId) || null;

    // Aggregate token usage by day. Excludes user_id and message content.
    const tokenUsageDaily = db.prepare(`
        SELECT DATE(created_at) AS day,
               SUM(input_tokens) AS total_input_tokens,
               SUM(output_tokens) AS total_output_tokens,
               SUM(cost_usd) AS total_cost_usd,
               COUNT(*) AS message_count,
               COUNT(DISTINCT user_id) AS distinct_users
        FROM token_usage
        WHERE guild_id = ?
        GROUP BY DATE(created_at)
        ORDER BY day DESC
    `).all(guildId);

    return {
        export_metadata: {
            guild_id: guildId,
            generated_at_utc: new Date().toISOString(),
            scope: 'all server-level data DiVA holds for this guild',
            note: 'Individual users\' reminders, conversations, and admin_tool_audit rows are NOT included — those are user-personal and only the user can export them via /data-export. Token usage is aggregated by day to give you spend visibility without exposing per-message content.',
            privacy_policy: 'https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/blob/main/PRIVACY.md',
        },
        guild_credits: guildCredits,
        credit_transactions: {
            count: creditTransactions.length,
            rows: creditTransactions,
        },
        guild_channels: guildChannels,
        guild_personality: guildPersonality,
        token_usage_daily: {
            count: tokenUsageDaily.length,
            note: 'Aggregated per-day. No per-user, no per-message detail.',
            rows: tokenUsageDaily,
        },
    };
}

/**
 * Wipe server-level config. Atomic. Returns counts of what was reset.
 *
 * Does NOT touch guild_credits, credit_transactions, or token_usage.
 */
export function deleteServerData(guildId) {
    const db = getDb();
    const txn = db.transaction(() => {
        const personalityDeleted = db.prepare(`
            DELETE FROM guild_personality WHERE guild_id = ?
        `).run(guildId).changes;

        const channelsDeleted = db.prepare(`
            DELETE FROM guild_channels WHERE guild_id = ?
        `).run(guildId).changes;

        return {
            guild_personality_deleted: personalityDeleted,
            guild_channels_deleted: channelsDeleted,
        };
    });
    return txn();
}

/**
 * Quick counts for the pre-confirmation UI on /server-data-delete.
 */
export function countServerData(guildId) {
    const db = getDb();
    const has = (sql) => (db.prepare(sql).get(guildId)?.n ?? 0) > 0;
    return {
        has_personality: has(`SELECT COUNT(*) AS n FROM guild_personality WHERE guild_id = ?`),
        has_channel_config: has(`SELECT COUNT(*) AS n FROM guild_channels WHERE guild_id = ?`),
    };
}
