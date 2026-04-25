/**
 * Per-user settings (timezone + secretary mode preferences).
 *
 * Used by:
 *   - reminders system (parses fire times in the user's local tz)
 *   - secretary mode (delivery preferences + daily digest schedule)
 *
 * Schema lives in src/db/init.js — see user_settings table.
 */

import { getDb } from './init.js';

export function ensureRow(userId) {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)`).run(userId);
}

export function getUserSettings(userId) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(userId);
    if (!row) {
        return {
            timezone: null,
            deliveryMode: null,
            deliveryChannelId: null,
            secretaryEnabled: false,
            secretaryTimeLocal: null,
            lastDigestSentAt: null,
        };
    }
    return {
        timezone: row.timezone,
        deliveryMode: row.delivery_mode,
        deliveryChannelId: row.delivery_channel_id,
        secretaryEnabled: row.secretary_enabled === 1,
        secretaryTimeLocal: row.secretary_time_local,
        lastDigestSentAt: row.last_digest_sent_at,
    };
}

export function setTimezone(userId, ianaZone) {
    ensureRow(userId);
    const db = getDb();
    db.prepare(`
        UPDATE user_settings
        SET timezone = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
    `).run(ianaZone, userId);
}

/**
 * Set delivery preferences (used by /secretary on wizard and recurring reminders).
 * Pass deliveryChannelId = null for DM mode.
 */
export function setDeliveryPrefs(userId, deliveryMode, deliveryChannelId) {
    ensureRow(userId);
    const db = getDb();
    db.prepare(`
        UPDATE user_settings
        SET delivery_mode = ?, delivery_channel_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
    `).run(deliveryMode, deliveryChannelId, userId);
}

/**
 * Toggle the daily digest opt-in. timeLocal is HH:MM in the user's tz.
 */
export function setSecretary(userId, enabled, timeLocal) {
    ensureRow(userId);
    const db = getDb();
    db.prepare(`
        UPDATE user_settings
        SET secretary_enabled = ?,
            secretary_time_local = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
    `).run(enabled ? 1 : 0, timeLocal, userId);
}

/**
 * Mark that today's digest was sent (so we don't double-send across polls).
 */
export function markDigestSent(userId) {
    ensureRow(userId);
    const db = getDb();
    db.prepare(`
        UPDATE user_settings
        SET last_digest_sent_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
    `).run(userId);
}

/**
 * Wipe everything (used by /secretary clear).
 */
export function clearUserSettings(userId) {
    const db = getDb();
    db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).run(userId);
}

/**
 * All users with secretary digest enabled — used by the secretary scheduler.
 */
export function getAllSecretaryUsers() {
    const db = getDb();
    return db.prepare(`
        SELECT user_id, timezone, delivery_mode, delivery_channel_id,
               secretary_time_local, last_digest_sent_at
        FROM user_settings
        WHERE secretary_enabled = 1
            AND timezone IS NOT NULL
            AND secretary_time_local IS NOT NULL
            AND delivery_mode IS NOT NULL
    `).all();
}
