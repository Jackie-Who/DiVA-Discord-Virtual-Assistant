/**
 * Update notifier.
 *
 * On bot startup (production only), compares BOT_VERSION to
 * bot_metadata.last_announced_version. If newer, posts an update notice to
 * every guild that has notices_enabled = 1, then updates the metadata so we
 * don't repeat the announcement on the next restart of the same version.
 *
 * Channel resolution per guild:
 *   1. If guild_channels.notices_channel_id is set, use it.
 *   2. Otherwise fall back to guild.systemChannel (Discord's default
 *      "system" channel — usually #general).
 *   3. If neither exists or the bot can't post there, log and skip.
 *
 * Failures on individual guilds never crash startup or block other guilds.
 */

import config from '../config.js';
import logger from './logger.js';
import { getDb } from '../db/init.js';
import { getAllGuildsWithNoticesEnabled } from '../db/guildChannels.js';
import { BOT_VERSION, CHANGELOG } from '../version.js';

/**
 * SemVer comparison: returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a, b) {
    const pa = a.split('.').map(n => parseInt(n, 10));
    const pb = b.split('.').map(n => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

function getLastAnnouncedVersion() {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM bot_metadata WHERE key = 'last_announced_version'`).get();
    return row ? row.value : null;
}

function setLastAnnouncedVersion(version) {
    const db = getDb();
    db.prepare(`
        INSERT INTO bot_metadata (key, value, updated_at)
        VALUES ('last_announced_version', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(version);
}

function buildAnnouncement(prevVersion) {
    const bullets = CHANGELOG[BOT_VERSION] || [];
    let msg = `📢 **DiVA v${BOT_VERSION} is live!**`;
    if (prevVersion) {
        msg += ` _(updated from v${prevVersion})_`;
    } else {
        msg += ` _(this is your first announcement)_`;
    }
    if (bullets.length > 0) {
        msg += `\n\n**What's new:**\n` + bullets.map(b => `• ${b}`).join('\n');
    }
    msg += `\n\n_Don't want these? An admin can run \`/notices off\`._`;
    return msg.slice(0, 2000);
}

/**
 * Resolve which channel a notice should go to in a given guild.
 * Returns the channel object or null if nothing is usable.
 */
async function resolveNoticesChannel(client, guildId, configuredChannelId) {
    if (configuredChannelId) {
        try {
            const ch = await client.channels.fetch(configuredChannelId);
            if (ch && ch.isTextBased && ch.isTextBased()) return ch;
        } catch {
            // configured channel is gone — fall through to system channel
        }
    }
    try {
        const guild = await client.guilds.fetch(guildId);
        if (guild && guild.systemChannel) return guild.systemChannel;
    } catch {
        // guild fetch failed — bot may have been kicked
    }
    return null;
}

/**
 * Post a single guild's update notice. Logs and swallows any errors.
 */
async function notifyGuild(client, guild, announcement) {
    const channel = await resolveNoticesChannel(client, guild.guild_id, guild.notices_channel_id);
    if (!channel) {
        logger.warn('No usable notices channel — skipping', { guildId: guild.guild_id });
        return false;
    }
    try {
        await channel.send(announcement);
        logger.info('Update notice posted', { guildId: guild.guild_id, channelId: channel.id });
        return true;
    } catch (err) {
        logger.warn('Failed to post update notice (likely missing perms)', {
            guildId: guild.guild_id,
            channelId: channel.id,
            error: err.message,
        });
        return false;
    }
}

/**
 * Main entry point — runs once on bot startup.
 *
 * Returns silently in dev (BOT_ENV !== 'production') so local restarts never
 * spam servers during development.
 */
export async function runUpdateNotifier(client) {
    if (!config.isProd) {
        logger.debug('Skipping update notifier (not production)', { env: config.botEnv });
        return;
    }

    const lastAnnounced = getLastAnnouncedVersion();
    if (lastAnnounced && compareVersions(BOT_VERSION, lastAnnounced) <= 0) {
        logger.debug('No newer version to announce', { current: BOT_VERSION, last: lastAnnounced });
        return;
    }

    logger.info('New version detected — posting update notices', {
        current: BOT_VERSION,
        previous: lastAnnounced || '(first run)',
    });

    let guildsToNotify;
    try {
        guildsToNotify = getAllGuildsWithNoticesEnabled();
    } catch (err) {
        logger.error('Failed to query opted-in guilds — aborting notice', { error: err.message });
        return;
    }

    if (guildsToNotify.length === 0) {
        logger.info('No guilds with notices enabled');
        // Still update last_announced_version so we don't keep checking forever.
        setLastAnnouncedVersion(BOT_VERSION);
        return;
    }

    const announcement = buildAnnouncement(lastAnnounced);
    let posted = 0;
    let failed = 0;

    for (const g of guildsToNotify) {
        const ok = await notifyGuild(client, g, announcement);
        if (ok) posted++; else failed++;
    }

    setLastAnnouncedVersion(BOT_VERSION);

    logger.info('Update notice complete', {
        version: BOT_VERSION,
        guildsPosted: posted,
        guildsFailed: failed,
    });
}
