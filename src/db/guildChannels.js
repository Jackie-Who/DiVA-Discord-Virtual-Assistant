/**
 * Per-guild channel routing config.
 *
 * Lets each server admin choose which channel receives:
 *   - error_channel_id: error notifications (alongside the global owner channel)
 *   - metrics_channel_id: weekly per-guild usage report
 *   - notices_channel_id: update notices when a new bot version ships
 *
 * Plus two flags:
 *   - notices_enabled: opt-OUT of update notices (default 1 = ON)
 *   - weekly_metrics_enabled: opt-IN to per-guild weekly reports (default 0 = OFF)
 *
 * Slash command: /channel set <kind> #channel  (admin-only, ManageGuild)
 */

import { getDb } from './init.js';

export function ensureRow(guildId) {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO guild_channels (guild_id) VALUES (?)`).run(guildId);
}

export function getGuildChannels(guildId) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM guild_channels WHERE guild_id = ?`).get(guildId);
    if (!row) {
        return {
            errorChannelId: null,
            metricsChannelId: null,
            noticesChannelId: null,
            noticesEnabled: true, // default opt-OUT (every server gets notices)
            weeklyMetricsEnabled: false,
        };
    }
    return {
        errorChannelId: row.error_channel_id,
        metricsChannelId: row.metrics_channel_id,
        noticesChannelId: row.notices_channel_id,
        noticesEnabled: row.notices_enabled === 1,
        weeklyMetricsEnabled: row.weekly_metrics_enabled === 1,
    };
}

export function setErrorChannel(guildId, channelId) {
    ensureRow(guildId);
    const db = getDb();
    db.prepare(`UPDATE guild_channels SET error_channel_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`)
      .run(channelId, guildId);
}

export function setMetricsChannel(guildId, channelId) {
    ensureRow(guildId);
    const db = getDb();
    db.prepare(`
        UPDATE guild_channels
        SET metrics_channel_id = ?,
            weekly_metrics_enabled = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
    `).run(channelId, guildId);
}

export function setNoticesChannel(guildId, channelId) {
    ensureRow(guildId);
    const db = getDb();
    db.prepare(`UPDATE guild_channels SET notices_channel_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`)
      .run(channelId, guildId);
}

export function setNoticesEnabled(guildId, enabled) {
    ensureRow(guildId);
    const db = getDb();
    db.prepare(`UPDATE guild_channels SET notices_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`)
      .run(enabled ? 1 : 0, guildId);
}

/**
 * Set of guild IDs that have EXPLICITLY disabled notices.
 *
 * "Opt-OUT" default means: every guild the bot is in receives notices unless
 * an admin ran /notices off (which writes notices_enabled = 0). Guilds with no
 * row at all are still considered enabled. The update notifier enumerates
 * client.guilds.cache and excludes the IDs returned here.
 */
export function getDisabledNoticeGuildIds() {
    const db = getDb();
    return new Set(
        db.prepare(`SELECT guild_id FROM guild_channels WHERE notices_enabled = 0`)
          .all()
          .map(r => r.guild_id)
    );
}

/**
 * Returns the configured notices_channel_id for a single guild (null if not set).
 */
export function getNoticesChannelId(guildId) {
    const db = getDb();
    const row = db.prepare(`SELECT notices_channel_id FROM guild_channels WHERE guild_id = ?`).get(guildId);
    return row?.notices_channel_id || null;
}

/**
 * All guilds opted into weekly metrics — used by the weekly metrics scheduler.
 */
export function getAllGuildsWithWeeklyMetrics() {
    const db = getDb();
    return db.prepare(`
        SELECT guild_id, metrics_channel_id
        FROM guild_channels
        WHERE weekly_metrics_enabled = 1 AND metrics_channel_id IS NOT NULL
    `).all();
}
