/**
 * Weekly Metrics Summary
 *
 * Sends a usage summary every Sunday at 9:00 PM Pacific to a private channel.
 * Runs entirely via source code — no AI model involvement.
 */

import { getDb } from '../db/init.js';
// (token budget imports removed in v1.2 — credit data is queried directly below)
import config from '../config.js';
import logger from './logger.js';

let metricsClient = null;
let metricsTimer = null;

// setTimeout max safe value (24.8 days) — anything larger overflows 32-bit signed int
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Initialize the weekly metrics system with the Discord client.
 * Waits for the client to be ready before scheduling.
 */
export function initWeeklyMetrics(client) {
    metricsClient = client;

    if (client.isReady()) {
        scheduleNextSunday();
    } else {
        client.once('ready', () => scheduleNextSunday());
    }

    logger.info('Weekly metrics scheduler initialized (Sunday 9 PM Pacific)');
}

/**
 * Calculate ms until next Sunday at 9:00 PM Pacific.
 */
function msUntilNextSunday9PMPacific() {
    const now = new Date();

    // Get current time in Pacific
    const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

    // Find next Sunday
    const daysUntilSunday = (7 - pacificNow.getDay()) % 7 || 7; // 0 = Sunday, so if it's Sunday, go to next
    const nextSunday = new Date(pacificNow);
    nextSunday.setDate(pacificNow.getDate() + daysUntilSunday);
    nextSunday.setHours(21, 0, 0, 0); // 9 PM

    // If it's Sunday and before 9 PM, use today
    if (pacificNow.getDay() === 0 && pacificNow.getHours() < 21) {
        nextSunday.setDate(pacificNow.getDate());
    }

    // Convert back to UTC offset difference
    const pacificOffset = pacificNow.getTime() - now.getTime();
    const targetUTC = new Date(nextSunday.getTime() - pacificOffset);

    const ms = targetUTC.getTime() - now.getTime();
    return Math.max(ms, 60_000); // At least 1 minute
}

function scheduleNextSunday() {
    if (metricsTimer) clearTimeout(metricsTimer);

    const ms = msUntilNextSunday9PMPacific();
    const hours = (ms / (1000 * 60 * 60)).toFixed(1);
    logger.info('Next weekly metrics in', { hours: `${hours}h`, ms });

    if (ms > MAX_TIMEOUT_MS) {
        // Sleep for 24 hours then re-check (avoids 32-bit overflow)
        metricsTimer = setTimeout(() => scheduleNextSunday(), 24 * 60 * 60 * 1000);
    } else {
        metricsTimer = setTimeout(async () => {
            await sendWeeklyMetrics();
            scheduleNextSunday();
        }, ms);
    }
}

/**
 * Gather metrics for the past 7 days and the current month.
 */
function gatherMetrics() {
    const db = getDb();

    // Week stats (last 7 days)
    const weekStats = db.prepare(`
        SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(input_tokens), 0) as total_input,
            COALESCE(SUM(output_tokens), 0) as total_output,
            COALESCE(SUM(cost_usd), 0) as total_cost,
            COUNT(DISTINCT guild_id) as active_guilds,
            COUNT(DISTINCT user_id) as active_users
        FROM token_usage
        WHERE created_at > datetime('now', '-7 days')
    `).get();

    // Top users this week
    const topUsers = db.prepare(`
        SELECT user_id, COUNT(*) as calls, SUM(cost_usd) as cost
        FROM token_usage
        WHERE created_at > datetime('now', '-7 days')
        GROUP BY user_id
        ORDER BY cost DESC
        LIMIT 5
    `).all();

    // Top guilds this week
    const topGuilds = db.prepare(`
        SELECT guild_id, COUNT(*) as calls, SUM(cost_usd) as cost
        FROM token_usage
        WHERE created_at > datetime('now', '-7 days')
        GROUP BY guild_id
        ORDER BY cost DESC
        LIMIT 5
    `).all();

    // Daily breakdown
    const dailyBreakdown = db.prepare(`
        SELECT
            DATE(created_at) as day,
            COUNT(*) as calls,
            SUM(cost_usd) as cost
        FROM token_usage
        WHERE created_at > datetime('now', '-7 days')
        GROUP BY DATE(created_at)
        ORDER BY day
    `).all();

    // Conversations this week
    const conversations = db.prepare(`
        SELECT COUNT(*) as count
        FROM conversations
        WHERE created_at > datetime('now', '-7 days') AND role = 'user'
    `).get();

    // Per-guild credit balances (v1.2+: replaces the old global monthly budget summary)
    const guildCredits = db.prepare(`
        SELECT guild_id, lifetime_credits_usd, total_spent_usd, owner_managed
        FROM guild_credits
        ORDER BY total_spent_usd DESC
    `).all();

    const totalLifetime = guildCredits.reduce((sum, g) => sum + g.lifetime_credits_usd, 0);
    const totalSpent = guildCredits.reduce((sum, g) => sum + g.total_spent_usd, 0);
    const totalRemaining = Math.max(0, totalLifetime - totalSpent);

    return {
        weekStats, topUsers, topGuilds, dailyBreakdown, conversations,
        guildCredits, totalLifetime, totalSpent, totalRemaining,
    };
}

/**
 * Format metrics into a Discord message.
 */
function formatMetricsMessage(metrics) {
    const { weekStats, topUsers, topGuilds, dailyBreakdown, conversations,
            guildCredits, totalLifetime, totalSpent, totalRemaining } = metrics;

    const avgCostPerCall = weekStats.total_calls > 0
        ? (weekStats.total_cost / weekStats.total_calls).toFixed(4)
        : '0.00';

    let msg = `<@${config.notifyUserId}>\n`;
    msg += `# 📊 Weekly Bot Metrics\n\n`;

    // Week summary
    msg += `## This Week (Last 7 Days)\n`;
    msg += `- **API Calls:** ${weekStats.total_calls.toLocaleString()}\n`;
    msg += `- **Conversations:** ${conversations.count.toLocaleString()}\n`;
    msg += `- **Active Guilds:** ${weekStats.active_guilds}\n`;
    msg += `- **Active Users:** ${weekStats.active_users}\n`;
    msg += `- **Input Tokens:** ${weekStats.total_input.toLocaleString()}\n`;
    msg += `- **Output Tokens:** ${weekStats.total_output.toLocaleString()}\n`;
    msg += `- **Week Cost:** $${weekStats.total_cost.toFixed(4)}\n`;
    msg += `- **Avg Cost/Call:** $${avgCostPerCall}\n\n`;

    // Daily breakdown
    if (dailyBreakdown.length > 0) {
        msg += `## Daily Breakdown\n`;
        msg += `\`\`\`\n`;
        msg += `Date        │ Calls │ Cost\n`;
        msg += `────────────┼───────┼─────────\n`;
        for (const day of dailyBreakdown) {
            const d = day.day.padEnd(12);
            const c = String(day.calls).padStart(5);
            const cost = `$${day.cost.toFixed(4)}`.padStart(9);
            msg += `${d}│${c} │${cost}\n`;
        }
        msg += `\`\`\`\n\n`;
    }

    // Top users
    if (topUsers.length > 0) {
        msg += `## Top Users\n`;
        for (let i = 0; i < topUsers.length; i++) {
            msg += `${i + 1}. <@${topUsers[i].user_id}> — ${topUsers[i].calls} calls, $${topUsers[i].cost.toFixed(4)}\n`;
        }
        msg += `\n`;
    }

    // Top guilds
    if (topGuilds.length > 0) {
        msg += `## Top Guilds\n`;
        for (let i = 0; i < topGuilds.length; i++) {
            msg += `${i + 1}. \`${topGuilds[i].guild_id}\` — ${topGuilds[i].calls} calls, $${topGuilds[i].cost.toFixed(4)}\n`;
        }
        msg += `\n`;
    }

    // Per-guild credit balances (v1.2+ replaces the old global monthly summary)
    msg += `## Credit Balances (All Guilds)\n`;
    msg += `- **Total Lifetime Granted:** $${totalLifetime.toFixed(4)}\n`;
    msg += `- **Total Spent:** $${totalSpent.toFixed(4)}\n`;
    msg += `- **Total Remaining:** $${totalRemaining.toFixed(4)}\n\n`;

    if (guildCredits.length > 0) {
        msg += `### Per-Guild Detail\n`;
        msg += `\`\`\`\n`;
        msg += `Guild ID             │ Lifetime  │ Spent     │ Remaining │ %    │ Mgd\n`;
        msg += `─────────────────────┼───────────┼───────────┼───────────┼──────┼─────\n`;
        for (const g of guildCredits) {
            const id = g.guild_id.padEnd(20).slice(0, 20);
            const lt = `$${g.lifetime_credits_usd.toFixed(2)}`.padStart(9);
            const sp = `$${g.total_spent_usd.toFixed(4)}`.padStart(9);
            const rem = Math.max(0, g.lifetime_credits_usd - g.total_spent_usd);
            const remStr = `$${rem.toFixed(4)}`.padStart(9);
            const pct = g.lifetime_credits_usd > 0
                ? `${((g.total_spent_usd / g.lifetime_credits_usd) * 100).toFixed(0)}%`
                : '—';
            const pctStr = pct.padStart(4);
            const mgd = g.owner_managed ? 'OWN' : '—';
            msg += `${id} │${lt} │${sp} │${remStr} │${pctStr}  │ ${mgd}\n`;
        }
        msg += `\`\`\`\n`;
    }

    return msg;
}

/**
 * Send the weekly metrics to the configured channel.
 */
async function sendWeeklyMetrics() {
    if (!metricsClient) {
        logger.error('Metrics client not initialized');
        return;
    }

    try {
        const channel = await metricsClient.channels.fetch(config.metricsChannelId);
        if (!channel) {
            logger.error('Metrics channel not found', { channelId: config.metricsChannelId });
            return;
        }

        const metrics = gatherMetrics();
        const message = formatMetricsMessage(metrics);

        // Discord 2000 char limit — split if needed
        if (message.length <= 2000) {
            await channel.send(message);
        } else {
            // Split on double newlines
            const parts = [];
            let remaining = message;
            while (remaining.length > 0) {
                if (remaining.length <= 2000) {
                    parts.push(remaining);
                    break;
                }
                let splitAt = remaining.lastIndexOf('\n\n', 2000);
                if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', 2000);
                if (splitAt < 500) splitAt = 2000;
                parts.push(remaining.slice(0, splitAt));
                remaining = remaining.slice(splitAt).trimStart();
            }
            for (const part of parts) {
                await channel.send(part);
            }
        }

        logger.info('Weekly metrics sent', { channelId: config.metricsChannelId });
    } catch (err) {
        logger.error('Failed to send weekly metrics', { error: err.message, stack: err.stack });
    }
}

/**
 * Manually trigger a metrics send (for testing).
 */
export async function sendMetricsNow() {
    await sendWeeklyMetrics();
}
