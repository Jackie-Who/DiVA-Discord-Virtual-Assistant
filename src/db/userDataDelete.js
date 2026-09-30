/**
 * GDPR / CCPA / PIPEDA "right to erasure" — wipe a user's data within a
 * single guild. Used by the `/data-delete` slash command.
 *
 * SCOPE
 * -----
 * Per-server, NOT cross-guild. Running /data-delete in Server A does not
 * touch the same user's data in Server B. Rationale: a user in multiple
 * servers should be able to clean up one without nuking all.
 *
 * For the "remove me from every server" flow, the user runs /data-delete
 * once per server they're in.
 *
 * WHAT GETS WIPED IN A GUILD
 * --------------------------
 *   reminders        : hard delete (guild_id + user_id matched)
 *   conversations    : hard delete
 *   undo_actions     : hard delete
 *   token_usage      : anonymized — user_id replaced with a stable hash so
 *                      server billing accounting still sums correctly
 *   admin_tool_audit : anonymized — server admins keep abuse-investigation
 *                      forensics; the linkage to the now-departed user is severed
 *
 * NOT TOUCHED (intentionally)
 * ---------------------------
 *   user_settings    : user-keyed, NOT guild-keyed. Timezone + secretary
 *                      prefs are genuinely cross-server. If the user wants
 *                      those gone, they run /timezone or /secretary clear.
 *   guild_credits / credit_transactions : server-level accounting, not user data.
 *   guild_personality / guild_channels  : server-level config.
 */

import crypto from 'crypto';
import { getDb } from './init.js';

/**
 * Compute the stable anonymization hash for a userId. Same input always
 * produces the same output, so multiple deletions by the same user produce
 * consistent anonymized rows. Cannot be reversed without the original userId.
 */
export function anonymizeUserId(userId) {
    const hash = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
    return `deleted_${hash}`;
}

/**
 * Wipe + anonymize this user's data within a single guild.
 *
 * Atomic — wrapped in a transaction so a partial failure rolls back.
 *
 * @returns {object} counts of rows touched per table
 */
export function deleteUserDataInGuild(userId, guildId) {
    const db = getDb();
    const anonId = anonymizeUserId(userId);

    const txn = db.transaction(() => {
        const remindersDeleted = db.prepare(`
            DELETE FROM reminders WHERE user_id = ? AND guild_id = ?
        `).run(userId, guildId).changes;

        const conversationsDeleted = db.prepare(`
            DELETE FROM conversations WHERE user_id = ? AND guild_id = ?
        `).run(userId, guildId).changes;

        const undoActionsDeleted = db.prepare(`
            DELETE FROM undo_actions WHERE user_id = ? AND guild_id = ?
        `).run(userId, guildId).changes;

        const tokenUsageAnonymized = db.prepare(`
            UPDATE token_usage SET user_id = ? WHERE user_id = ? AND guild_id = ?
        `).run(anonId, userId, guildId).changes;

        const adminAuditAnonymized = db.prepare(`
            UPDATE admin_tool_audit SET user_id = ? WHERE user_id = ? AND guild_id = ?
        `).run(anonId, userId, guildId).changes;

        // Role selectors are server content — they stay live; only authorship is anonymized.
        const roleSelectorsAnonymized = db.prepare(`
            UPDATE role_selectors SET created_by = ? WHERE created_by = ? AND guild_id = ?
        `).run(anonId, userId, guildId).changes;

        return {
            role_selectors_anonymized: roleSelectorsAnonymized,
            reminders_deleted: remindersDeleted,
            conversations_deleted: conversationsDeleted,
            undo_actions_deleted: undoActionsDeleted,
            token_usage_anonymized: tokenUsageAnonymized,
            admin_tool_audit_anonymized: adminAuditAnonymized,
            anonymized_as: anonId,
        };
    });

    return txn();
}

/**
 * Pre-flight summary so the user can see what's about to be deleted before
 * confirming. Mirrors the WHERE clauses in deleteUserDataInGuild.
 */
export function countUserDataInGuild(userId, guildId) {
    const db = getDb();
    const get = (sql) => db.prepare(sql).get(userId, guildId)?.n ?? 0;
    return {
        reminders: get(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND guild_id = ?`),
        conversations: get(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND guild_id = ?`),
        undo_actions: get(`SELECT COUNT(*) AS n FROM undo_actions WHERE user_id = ? AND guild_id = ?`),
        token_usage: get(`SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ? AND guild_id = ?`),
        admin_tool_audit: get(`SELECT COUNT(*) AS n FROM admin_tool_audit WHERE user_id = ? AND guild_id = ?`),
        role_selectors: get(`SELECT COUNT(*) AS n FROM role_selectors WHERE created_by = ? AND guild_id = ?`),
    };
}
