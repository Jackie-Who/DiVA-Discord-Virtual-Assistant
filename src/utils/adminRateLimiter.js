/**
 * Admin Tool Rate Limiter
 *
 * Limits admin tool executions to prevent abuse or accidental spam.
 * Per-guild cooldown: max 10 tool calls per 60 seconds.
 */

import logger from './logger.js';

const MAX_CALLS = 10;
const WINDOW_MS = 60_000; // 60 seconds

// Map<guildId, { timestamps: number[] }>
const guildCalls = new Map();

// Cleanup stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [guildId, data] of guildCalls) {
        data.timestamps = data.timestamps.filter(t => now - t < WINDOW_MS);
        if (data.timestamps.length === 0) {
            guildCalls.delete(guildId);
        }
    }
}, 5 * 60_000);

/**
 * Check if the guild has exceeded its admin tool rate limit.
 * @param {string} guildId
 * @returns {{ allowed: boolean, remainingCalls: number, retryAfterMs: number }}
 */
export function checkAdminRateLimit(guildId) {
    const now = Date.now();

    if (!guildCalls.has(guildId)) {
        guildCalls.set(guildId, { timestamps: [] });
    }

    const data = guildCalls.get(guildId);

    // Remove expired timestamps
    data.timestamps = data.timestamps.filter(t => now - t < WINDOW_MS);

    if (data.timestamps.length >= MAX_CALLS) {
        const oldestInWindow = data.timestamps[0];
        const retryAfterMs = WINDOW_MS - (now - oldestInWindow);

        logger.warn('Admin tool rate limit hit', {
            guildId,
            callsInWindow: data.timestamps.length,
            retryAfterMs,
        });

        return {
            allowed: false,
            remainingCalls: 0,
            retryAfterMs,
        };
    }

    return {
        allowed: true,
        remainingCalls: MAX_CALLS - data.timestamps.length,
        retryAfterMs: 0,
    };
}

/**
 * Record a tool call for the guild.
 * Call this AFTER the tool executes successfully.
 * @param {string} guildId
 */
export function recordAdminToolCall(guildId) {
    if (!guildCalls.has(guildId)) {
        guildCalls.set(guildId, { timestamps: [] });
    }
    guildCalls.get(guildId).timestamps.push(Date.now());
}
