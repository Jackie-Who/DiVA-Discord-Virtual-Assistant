/**
 * GDPR / CCPA "right of access" — assemble every row in the database that
 * relates to a single Discord user, across every guild DiVA is in.
 *
 * Used by the `/data-export` slash command. Returns a structured object that
 * the caller serializes to JSON and attaches to an ephemeral message.
 *
 * Scope: cross-guild on purpose. PRIVACY.md §7 promises "all data we hold
 * about you", which lives across guilds — a user in two servers gets data
 * from both servers in their export. This means a server admin running
 * /admin-audit may see that the export ran, but does not see the contents
 * (the export is delivered ephemerally to the requester).
 *
 * Server-level artifacts (guild_personality, guild_credits, guild_channels,
 * credit_transactions) are intentionally NOT in the user export. They belong
 * to the server, not the user, and are accessible via /server-data-export
 * (server admin only) instead.
 */

import { getDb } from './init.js';

/**
 * Assemble the full export object for a user.
 *
 * @param {string} userId Discord user snowflake
 * @returns {object} structured export, ready for JSON.stringify
 */
export function assembleUserDataExport(userId) {
    const db = getDb();

    // — user_settings (single row, one per user) —
    const userSettings = db.prepare(`
        SELECT * FROM user_settings WHERE user_id = ?
    `).get(userId) || null;

    // — reminders (cross-guild) —
    const reminders = db.prepare(`
        SELECT id, guild_id, channel_id, fire_at_utc, message, recurrence,
               weekday, fire_time_local, parent_id, fired_at, cancelled_at,
               snooze_until_utc, created_at
        FROM reminders
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(userId);

    // — conversations (cross-guild, last 14d window enforced by sweep) —
    const conversations = db.prepare(`
        SELECT id, guild_id, channel_id, user_name, role, content, created_at
        FROM conversations
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(userId);

    // — token_usage (cross-guild, indefinite retention) —
    const tokenUsage = db.prepare(`
        SELECT id, guild_id, input_tokens, output_tokens, cost_usd, created_at
        FROM token_usage
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(userId);

    // — admin_tool_audit (cross-guild, 90d window) —
    const adminToolAudit = db.prepare(`
        SELECT id, guild_id, tool_name, input_json, success, error_message, created_at
        FROM admin_tool_audit
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(userId);

    // — role_selectors created by this user (cross-guild) —
    const roleSelectorsCreated = db.prepare(`
        SELECT message_id, guild_id, channel_id, title, description, exclusive, created_at, updated_at
        FROM role_selectors
        WHERE created_by = ?
        ORDER BY created_at DESC
    `).all(userId);

    // — undo_actions (cross-guild, 10-min TTL but include for completeness) —
    const undoActions = db.prepare(`
        SELECT id, guild_id, confirm_msg_id, action_json, created_at
        FROM undo_actions
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(userId);

    return {
        export_metadata: {
            user_id: userId,
            generated_at_utc: new Date().toISOString(),
            scope: 'all DiVA data linked to this Discord user, across every guild DiVA is in',
            note: 'Server-level data (server credits, server personality prompt, server channel routing) is not included here — those are server artifacts, not user-personal data, and are exported separately by server admins via /server-data-export.',
            privacy_policy: 'https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/blob/main/PRIVACY.md',
        },
        user_settings: userSettings,
        reminders: {
            count: reminders.length,
            note: 'Includes pending, fired (within 30-day retention), and cancelled reminders.',
            rows: reminders,
        },
        conversations: {
            count: conversations.length,
            note: 'Channel-memory and DM rows for messages where you interacted with DiVA. 14-day rolling retention.',
            rows: conversations,
        },
        token_usage: {
            count: tokenUsage.length,
            note: 'Per-message AI token cost records. Used for server-level billing transparency. Indefinite retention.',
            rows: tokenUsage,
        },
        admin_tool_audit: {
            count: adminToolAudit.length,
            note: 'Admin-tool actions DiVA performed in any server on your behalf. 90-day retention.',
            rows: adminToolAudit,
        },
        undo_actions: {
            count: undoActions.length,
            note: 'Pending undo records (10-minute TTL). Usually empty.',
            rows: undoActions,
        },
        role_selectors_created: {
            count: roleSelectorsCreated.length,
            note: 'Role selector messages you created. The selector itself belongs to the server; only your authorship is personal data.',
            rows: roleSelectorsCreated,
        },
    };
}

/**
 * Return a count summary without the full rows — used to confirm to the
 * user before they download / before they delete.
 */
export function countUserData(userId) {
    const db = getDb();
    const get = (sql) => db.prepare(sql).get(userId)?.n ?? 0;
    return {
        user_settings: get(`SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?`),
        reminders: get(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?`),
        conversations: get(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?`),
        token_usage: get(`SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ?`),
        admin_tool_audit: get(`SELECT COUNT(*) AS n FROM admin_tool_audit WHERE user_id = ?`),
        undo_actions: get(`SELECT COUNT(*) AS n FROM undo_actions WHERE user_id = ?`),
        role_selectors_created: get(`SELECT COUNT(*) AS n FROM role_selectors WHERE created_by = ?`),
    };
}
