import config from '../config.js';

const userTimestamps = new Map();
const channelTimestamps = new Map();

export function isRateLimited(userId, channelId) {
    const now = Date.now();

    // Per-user limit: 1 message per N seconds
    const userTimes = userTimestamps.get(userId) || [];
    const userCutoff = now - config.rateLimitUserSeconds * 1000;
    const recentUserTimes = userTimes.filter(t => t > userCutoff);

    if (recentUserTimes.length >= 1) {
        return true;
    }

    // Per-channel limit: N messages per M seconds
    const channelTimes = channelTimestamps.get(channelId) || [];
    const channelCutoff = now - config.rateLimitChannelSeconds * 1000;
    const recentChannelTimes = channelTimes.filter(t => t > channelCutoff);

    if (recentChannelTimes.length >= config.rateLimitChannelCount) {
        return true;
    }

    // Not rate limited — record this timestamp
    recentUserTimes.push(now);
    userTimestamps.set(userId, recentUserTimes);

    recentChannelTimes.push(now);
    channelTimestamps.set(channelId, recentChannelTimes);

    return false;
}

// Cleanup old timestamps every 60 seconds
setInterval(() => {
    const cutoff = Date.now() - 30_000;

    for (const [key, times] of userTimestamps) {
        const filtered = times.filter(t => t > cutoff);
        if (filtered.length === 0) {
            userTimestamps.delete(key);
        } else {
            userTimestamps.set(key, filtered);
        }
    }

    for (const [key, times] of channelTimestamps) {
        const filtered = times.filter(t => t > cutoff);
        if (filtered.length === 0) {
            channelTimestamps.delete(key);
        } else {
            channelTimestamps.set(key, filtered);
        }
    }
}, 60_000);
