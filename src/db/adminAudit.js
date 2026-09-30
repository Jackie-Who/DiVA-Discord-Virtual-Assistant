/**
 * Audit log for admin-tool executions. Every call into executeAdminTool —
 * successful or failed — writes one row here, so we can investigate abuse
 * after the fact (rapid credit consumption, suspicious tool patterns,
 * repeated permission grants, etc).
 *
 * Retention: 90 days, swept by cleanupExpiredAuditEntries() which is called
 * on the same interval as cleanupExpiredUndoActions in init.js.
 *
 * Privacy: input_json is capped at INPUT_JSON_MAX_LEN bytes so we don't
 * persist unbounded user content (channel topics, role names, nicknames,
 * etc). Disclosed in PRIVACY.md §3.5.
 */

import { getDb } from './init.js';
import logger from '../utils/logger.js';

const INPUT_JSON_MAX_LEN = 500;
const AUDIT_RETENTION_DAYS = 90;

/**
 * Record a single admin-tool execution. Never throws — audit failure must
 * not block the actual tool call from completing or returning.
 *
 * @param {object} entry
 * @param {string} entry.guildId
 * @param {string} entry.userId
 * @param {string} entry.toolName
 * @param {object} [entry.input]   - Raw tool input; will be JSON.stringified and truncated.
 * @param {boolean} entry.success
 * @param {string} [entry.errorMessage] - Set when success is false.
 */
export function recordAdminToolCall({ guildId, userId, toolName, input, success, errorMessage }) {
    try {
        const db = getDb();
        let inputJson = null;
        if (input !== undefined && input !== null) {
            try {
                inputJson = JSON.stringify(input).slice(0, INPUT_JSON_MAX_LEN);
            } catch {
                inputJson = '[unserializable]';
            }
        }
        db.prepare(`
            INSERT INTO admin_tool_audit
                (guild_id, user_id, tool_name, input_json, success, error_message)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            guildId,
            userId,
            toolName,
            inputJson,
            success ? 1 : 0,
            errorMessage || null
        );
    } catch (err) {
        // Never let audit failure surface to the user. Log and move on.
        logger.error('Failed to record admin tool audit entry', {
            error: err.message,
            toolName,
            guildId,
            userId,
        });
    }
}

/**
 * Fetch the most recent audit entries for a guild, optionally filtered by user.
 * Used by the /admin-audit slash command.
 */
export function listRecentAuditEntries(guildId, { userId = null, limit = 50 } = {}) {
    const db = getDb();
    const params = [guildId];
    let sql = `
        SELECT id, guild_id, user_id, tool_name, input_json, success, error_message, created_at
        FROM admin_tool_audit
        WHERE guild_id = ?
    `;
    if (userId) {
        sql += ' AND user_id = ?';
        params.push(userId);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.max(1, Math.min(200, limit)));
    return db.prepare(sql).all(...params);
}

/**
 * Delete audit rows older than AUDIT_RETENTION_DAYS. Called on the same
 * interval that prunes expired undo actions.
 */
export function cleanupExpiredAuditEntries() {
    try {
        const db = getDb();
        const result = db.prepare(`
            DELETE FROM admin_tool_audit
            WHERE created_at < datetime('now', ?)
        `).run(`-${AUDIT_RETENTION_DAYS} days`);
        if (result.changes > 0) {
            logger.debug('Pruned expired admin-tool audit entries', { deleted: result.changes });
        }
    } catch (err) {
        logger.error('Failed to prune admin tool audit entries', { error: err.message });
    }
}
