/**
 * Reminders: per-user scheduled messages.
 *
 * Each row represents a single scheduled fire. One-shot reminders are a single
 * row that gets `fired_at` set when delivered. Recurring rules generate a child
 * row for the next instance each time they fire (linked via `parent_id`), so
 * the scheduler always works with single-fire rows.
 *
 * recurrence ∈ { null, 'daily', 'weekly' } — strictly enforced by the tool layer.
 */

import { getDb } from './init.js';

/**
 * Create a one-shot reminder.
 * @returns {number} the new row id
 */
export function createOneShot({ guildId, channelId, userId, fireAtUtc, message }) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO reminders (guild_id, channel_id, user_id, fire_at_utc, message)
        VALUES (?, ?, ?, ?, ?)
    `).run(guildId, channelId, userId, fireAtUtc, message);
    return result.lastInsertRowid;
}

/**
 * Create a recurring reminder rule. Inserts the FIRST scheduled instance with
 * recurrence/weekday/fire_time_local set. Subsequent instances are inserted by
 * the scheduler when each one fires (linked via parent_id).
 *
 * The first row's `id` is used as the parent_id for all future instances of
 * this rule, so cancellation can find every related instance via parent_id.
 *
 * @returns {number} the new rule's id
 */
export function createRecurring({
    guildId, channelId, userId, fireAtUtc, message,
    recurrence, weekday, fireTimeLocal,
}) {
    if (recurrence !== 'daily' && recurrence !== 'weekly') {
        throw new Error(`recurrence must be 'daily' or 'weekly' (got '${recurrence}')`);
    }
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO reminders
            (guild_id, channel_id, user_id, fire_at_utc, message,
             recurrence, weekday, fire_time_local)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, channelId, userId, fireAtUtc, message,
           recurrence, weekday, fireTimeLocal);
    const newId = result.lastInsertRowid;

    // Self-link parent_id so all instances of this rule share an anchor.
    db.prepare(`UPDATE reminders SET parent_id = ? WHERE id = ?`).run(newId, newId);
    return newId;
}

/**
 * Insert the next instance of a recurring rule (called by the scheduler when
 * an instance fires).
 */
export function insertNextRecurringInstance({
    parentId, guildId, channelId, userId, fireAtUtc, message,
    recurrence, weekday, fireTimeLocal,
}) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO reminders
            (parent_id, guild_id, channel_id, user_id, fire_at_utc, message,
             recurrence, weekday, fire_time_local)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(parentId, guildId, channelId, userId, fireAtUtc, message,
           recurrence, weekday, fireTimeLocal);
    return result.lastInsertRowid;
}

export function getReminderById(id) {
    const db = getDb();
    return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
}

/**
 * All pending (not fired, not cancelled) reminders within the next `hours`.
 * Used by the scheduler on startup and during the hourly sweep.
 */
export function getPendingWithinHours(hours) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM reminders
        WHERE fired_at IS NULL
          AND cancelled_at IS NULL
          AND fire_at_utc <= datetime('now', ?)
        ORDER BY fire_at_utc ASC
    `).all(`+${hours} hours`);
}

/**
 * Active reminders for a specific user (for /reminder list and natural-language list).
 * Returns:
 *   - upcoming one-shots (recurrence IS NULL, not fired, not cancelled)
 *   - the latest pending instance of each recurring rule
 */
export function getActiveRemindersForUser(userId) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM reminders
        WHERE user_id = ?
          AND fired_at IS NULL
          AND cancelled_at IS NULL
        ORDER BY fire_at_utc ASC
    `).all(userId);
}

/**
 * Cancel a single pending reminder (one-shot OR a recurring rule + all its pending children).
 * Returns the number of rows cancelled.
 */
export function cancelReminder(id, userId) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId || row.fired_at || row.cancelled_at) return 0;

    const txn = db.transaction(() => {
        if (row.recurrence) {
            // Cancel the rule and any pending child instances of the rule
            const parentAnchor = row.parent_id || row.id;
            return db.prepare(`
                UPDATE reminders
                SET cancelled_at = CURRENT_TIMESTAMP
                WHERE (id = ? OR parent_id = ?)
                  AND fired_at IS NULL
                  AND cancelled_at IS NULL
                  AND user_id = ?
            `).run(parentAnchor, parentAnchor, userId).changes;
        } else {
            return db.prepare(`
                UPDATE reminders
                SET cancelled_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ?
            `).run(id, userId).changes;
        }
    });
    return txn();
}

/**
 * Reschedule a pending reminder. For recurring rules, this updates the next
 * pending instance's fire_at_utc and the rule's fire_time_local (so future
 * instances also use the new time).
 *
 * Returns the new fire_at_utc on success, or null if the reminder isn't
 * found/owned/pending.
 */
export function rescheduleOneShot(id, userId, newFireAtUtc) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId || row.fired_at || row.cancelled_at) return null;
    if (row.recurrence) return null; // use rescheduleRecurring instead

    db.prepare(`UPDATE reminders SET fire_at_utc = ? WHERE id = ?`).run(newFireAtUtc, id);
    return newFireAtUtc;
}

/**
 * Reschedule a recurring rule: updates fire_time_local for future instances
 * AND the next pending instance's fire_at_utc.
 */
export function rescheduleRecurring(id, userId, { newFireAtUtc, newFireTimeLocal, newWeekday }) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId || row.fired_at || row.cancelled_at) return null;
    if (!row.recurrence) return null; // use rescheduleOneShot instead

    const txn = db.transaction(() => {
        // Update this row's time + rule meta
        db.prepare(`
            UPDATE reminders
            SET fire_at_utc = ?,
                fire_time_local = COALESCE(?, fire_time_local),
                weekday = COALESCE(?, weekday)
            WHERE id = ?
        `).run(newFireAtUtc, newFireTimeLocal, newWeekday, id);
    });
    txn();
    return newFireAtUtc;
}

export function markFired(id) {
    const db = getDb();
    db.prepare(`UPDATE reminders SET fired_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

/**
 * Dismiss a SINGLE reminder instance (used by the pre-fire "Dismiss" button).
 *
 * Behavior:
 *   - One-shot: marks cancelled_at on this row.
 *   - Recurring: marks cancelled_at on this instance ONLY. The recurring rule
 *     itself stays active — the caller (scheduler) inserts the next instance
 *     so the rule keeps firing on its normal cadence.
 *
 * Returns the dismissed row on success (so the caller knows whether it was
 * recurring and what fire_at_utc the next instance should anchor to), or null
 * if the reminder doesn't exist / isn't owned by the user / already fired or
 * cancelled.
 */
export function dismissReminderInstance(id, userId) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId || row.fired_at || row.cancelled_at) return null;
    db.prepare(`UPDATE reminders SET cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`)
      .run(id, userId);
    return row;
}

/**
 * Set snooze_until_utc on a reminder. Used by the pre-fire "Snooze" button:
 * when clicked, we set this to (fire_at_utc - 30min) and schedule a follow-up
 * ping at that time. Returns true on success, false if the reminder isn't
 * pending or isn't owned by the user.
 */
export function setSnoozeUntil(id, userId, snoozeAtUtcSqlite) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId || row.fired_at || row.cancelled_at) return false;
    db.prepare(`UPDATE reminders SET snooze_until_utc = ? WHERE id = ? AND user_id = ?`)
      .run(snoozeAtUtcSqlite, id, userId);
    return true;
}

/**
 * Clear snooze_until_utc on a reminder (called when the snooze ping fires,
 * or when the reminder is cancelled/rescheduled).
 */
export function clearSnooze(id) {
    const db = getDb();
    db.prepare(`UPDATE reminders SET snooze_until_utc = NULL WHERE id = ?`).run(id);
}

/**
 * All reminders with an active snooze (snooze_until_utc set, not fired, not
 * cancelled). Used by the scheduler on startup to re-arm snooze timers.
 */
export function getActiveSnoozes() {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM reminders
        WHERE snooze_until_utc IS NOT NULL
          AND fired_at IS NULL
          AND cancelled_at IS NULL
        ORDER BY snooze_until_utc ASC
    `).all();
}

/**
 * Replace a reminder's message text. Used by the AI-suggested-title button so
 * the user can swap their original title for an optimized version after creation.
 *
 * Ownership is enforced via the WHERE clause so we never accidentally edit
 * another user's row. Returns true if a row was updated.
 *
 * For recurring rules, also updates any pending child instances so the next
 * fire uses the new title too.
 */
export function updateReminderMessage(id, userId, newMessage) {
    const db = getDb();
    const row = getReminderById(id);
    if (!row || row.user_id !== userId) return false;
    if (row.fired_at || row.cancelled_at) return false;

    const txn = db.transaction(() => {
        db.prepare(`UPDATE reminders SET message = ? WHERE id = ? AND user_id = ?`)
          .run(newMessage, id, userId);
        // For recurring rules, propagate to any pending child instances
        if (row.recurrence) {
            const anchor = row.parent_id || row.id;
            db.prepare(`
                UPDATE reminders
                SET message = ?
                WHERE (id = ? OR parent_id = ?)
                  AND user_id = ?
                  AND fired_at IS NULL
                  AND cancelled_at IS NULL
            `).run(newMessage, anchor, anchor, userId);
        }
    });
    txn();
    return true;
}

/**
 * Fuzzy match for natural-language cancel/reschedule.
 * Searches active reminders for the user where `query` appears in message (case-insensitive).
 * Returns up to `limit` matches.
 */
export function findActiveByQuery(userId, query, limit = 5) {
    if (!query || query.trim().length === 0) return [];
    const db = getDb();
    const like = `%${query.trim()}%`;
    return db.prepare(`
        SELECT * FROM reminders
        WHERE user_id = ?
          AND fired_at IS NULL
          AND cancelled_at IS NULL
          AND LOWER(message) LIKE LOWER(?)
        ORDER BY fire_at_utc ASC
        LIMIT ?
    `).all(userId, like, limit);
}

/**
 * Cleanup old fired/cancelled reminders. Keeps the most recent N days of history.
 * Recurring "rule" rows (where recurrence IS NOT NULL AND parent_id = id) are
 * preserved as long as they aren't cancelled, since they're the source of truth
 * for the rule itself.
 */
export function cleanupExpiredReminders(days = 30) {
    const db = getDb();
    const result = db.prepare(`
        DELETE FROM reminders
        WHERE (fired_at IS NOT NULL OR cancelled_at IS NOT NULL)
          AND COALESCE(fired_at, cancelled_at) < datetime('now', ?)
          AND NOT (recurrence IS NOT NULL AND parent_id = id AND cancelled_at IS NULL)
    `).run(`-${days} days`);
    return result.changes;
}
