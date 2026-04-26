/**
 * Error notifier.
 *
 * v1.2: errors fan out to (a) the global owner channel (config.errorChannelId,
 * for your monitoring), and (b) the per-guild error channel if the affected guild
 * has configured one via /channel set error #foo.
 *
 * Per-guild routing is opt-in: a guild without an error_channel_id only has its
 * errors sent to the global owner channel.
 */

import logger from './logger.js';
import config from '../config.js';
import { getGuildChannels } from '../db/guildChannels.js';

let discordClient = null;

export function initErrorNotifier(client) {
    discordClient = client;
}

/**
 * Send an error notification.
 * @param {object} opts
 * @param {string} opts.title  Short error title
 * @param {Error|string} opts.error  The error object (or message)
 * @param {object} [opts.context]  Optional key/value context map
 * @param {string} [opts.guildId]  If set, also routes to the guild's configured error channel
 */
export async function notifyError({ title, error, context, guildId }) {
    if (!discordClient) return;

    const timestamp = new Date().toISOString();
    const contextStr = context
        ? Object.entries(context).map(([k, v]) => `**${k}:** ${v}`).join('\n')
        : 'No additional context';

    const errorMsg = [
        config.notifyUserId ? `<@${config.notifyUserId}>` : '',
        `### \u{1F6A8} ${title}`,
        `**Time:** ${timestamp}`,
        contextStr,
        '```',
        (error?.stack || error?.message || String(error)).slice(0, 1500),
        '```',
    ].filter(Boolean).join('\n').slice(0, 2000);

    // Per-guild error channel for the affected server's admins (no @notify mention here —
    // they don't need to ping the bot owner).
    const guildErrorMsg = [
        `### \u{1F6A8} ${title}`,
        `**Time:** ${timestamp}`,
        contextStr,
        '```',
        (error?.stack || error?.message || String(error)).slice(0, 1500),
        '```',
    ].join('\n').slice(0, 2000);

    const targets = [];

    // Global owner channel (your monitoring)
    if (config.errorChannelId) {
        targets.push({ channelId: config.errorChannelId, body: errorMsg, label: 'global' });
    }

    // Per-guild channel if configured
    if (guildId) {
        try {
            const cfg = getGuildChannels(guildId);
            if (cfg.errorChannelId && cfg.errorChannelId !== config.errorChannelId) {
                targets.push({ channelId: cfg.errorChannelId, body: guildErrorMsg, label: `guild:${guildId}` });
            }
        } catch (lookupErr) {
            // DB lookup failed — log locally and continue with whatever else we can deliver
            logger.error('Failed to look up per-guild error channel', { error: lookupErr.message, guildId });
        }
    }

    for (const t of targets) {
        try {
            const channel = await discordClient.channels.fetch(t.channelId);
            if (channel) await channel.send(t.body);
        } catch (sendError) {
            // Don't recurse — just log locally
            logger.error('Failed to send error notification', {
                target: t.label,
                channelId: t.channelId,
                error: sendError.message,
            });
        }
    }
}
