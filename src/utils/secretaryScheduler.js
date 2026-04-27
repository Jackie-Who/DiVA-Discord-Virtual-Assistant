/**
 * Secretary mode daily digest scheduler.
 *
 * Pattern: every ~5 minutes, query all users who opted into the daily digest.
 * For each user, compute "today's fire UTC" (their secretary_time_local in their
 * timezone, on today's date in their tz, converted to UTC). If now is within
 * ±2.5 minutes of that fire time AND we haven't already sent today's digest in
 * the user's local-day, send it.
 *
 * 5-min polling avoids per-user setTimeout management across restarts and
 * crossing-midnight edge cases. The sub-window check (±2.5 min) means we land
 * each digest within a tight window without double-firing.
 *
 * Cost: each digest is ~150 in / ~200 out tokens on Haiku ≈ $0.0011. Cheap.
 */

import logger from './logger.js';
import anthropic from '../ai/client.js';
import { recordUsage, isGuildOutOfCredits } from '../db/tokenBudget.js';
import { getAllSecretaryUsers, markDigestSent } from '../db/userSettings.js';
import { getActiveRemindersForUser } from '../db/reminders.js';
import { discordTimestamp, parseSqliteUtc, nowInZone, localToUtc } from './timezone.js';

const POLL_INTERVAL_MS = 5 * 60_000;       // 5 minutes
const FIRE_WINDOW_MS  = 2.5 * 60_000;      // ±2.5 min around the user's chosen time
// 3 calendar days in the user's timezone (today + day+1 + day+2). Uses local-day
// boundaries — not a sliding 72h window — so the digest content matches what
// "today, tomorrow, day after" mean in the user's actual timezone.
const DIGEST_DAYS = 3;
const DIGEST_MODEL = 'claude-haiku-4-5-20251001';

let discordClient = null;
let pollHandle = null;

export function initSecretaryScheduler(client) {
    discordClient = client;

    if (client.isReady()) {
        runPoll();
    } else {
        client.once('ready', () => runPoll());
    }

    pollHandle = setInterval(() => runPoll(), POLL_INTERVAL_MS);
    logger.info('Secretary scheduler initialized (5-min poll)');
}

export function stopSecretaryScheduler() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
}

async function runPoll() {
    let users;
    try {
        users = getAllSecretaryUsers();
    } catch (err) {
        logger.error('Secretary poll DB query failed', { error: err.message });
        return;
    }

    if (users.length === 0) return;

    const now = Date.now();
    for (const u of users) {
        try {
            await checkUser(u, now);
        } catch (err) {
            logger.error('Secretary digest check failed for user', { userId: u.user_id, error: err.message });
        }
    }
}

async function checkUser(user, now) {
    const tz = user.timezone;
    const localTime = user.secretary_time_local; // "HH:MM"
    if (!tz || !localTime) return;

    // Compute today's fire-at UTC (today's date in tz @ HH:MM)
    const tzNow = nowInZone(tz);
    const todayLocalStr = `${pad(tzNow.year, 4)}-${pad(tzNow.month)}-${pad(tzNow.day)} ${localTime}`;
    let todayFireUtc;
    try {
        todayFireUtc = localToUtc(todayLocalStr, tz);
    } catch (err) {
        logger.warn('Secretary: bad tz/time for user', { userId: user.user_id, tz, localTime, err: err.message });
        return;
    }

    const delta = Math.abs(now - todayFireUtc.getTime());
    if (delta > FIRE_WINDOW_MS) return; // not in the firing window

    // Have we already sent today's digest? Compare by local date in user's tz.
    if (user.last_digest_sent_at) {
        const lastSent = parseSqliteUtc(user.last_digest_sent_at);
        if (sameLocalDay(lastSent, new Date(now), tz)) {
            return; // already fired today
        }
    }

    // Build and send. Delegates to buildAndSendDigest which is also used by the
    // dev tool (tools/test-secretary-digest.js) to preview digests on demand.
    await buildAndSendDigest(user, now);
}

/**
 * Build and send a single user's digest. Extracted from checkUser so the dev
 * test script (tools/test-secretary-digest.js) can fire it on demand without
 * tripping the fire-window or already-sent-today checks.
 *
 * Returns { success, kind, reminderCount, reason? } for the caller to log.
 */
export async function sendDigestForUserNow(client, userId) {
    if (!client || !client.isReady?.()) {
        return { success: false, reason: 'client not ready' };
    }
    // Lazy-import the user-settings DB helper to avoid circular import at module load
    const { getUserSettings } = await import('../db/userSettings.js');
    const settings = getUserSettings(userId);
    if (!settings.timezone) {
        return { success: false, reason: 'user has no timezone set' };
    }
    if (!settings.deliveryMode) {
        return { success: false, reason: 'user has no delivery preference (run /secretary on)' };
    }
    // Reshape into the row-style object the existing helpers expect
    const userRow = {
        user_id: userId,
        timezone: settings.timezone,
        delivery_mode: settings.deliveryMode,
        delivery_channel_id: settings.deliveryChannelId,
        secretary_enabled: settings.secretaryEnabled ? 1 : 0,
        secretary_time_local: settings.secretaryTimeLocal,
        last_digest_sent_at: null, // bypass "already sent today" check
    };
    // Set this scheduler's client if not already (so target resolution works)
    if (!discordClient) discordClient = client;
    return buildAndSendDigest(userRow, Date.now());
}

async function buildAndSendDigest(user, now) {
    const tz = user.timezone;
    const tzNow = nowInZone(tz);

    const reminders = getActiveRemindersForUser(user.user_id);

    // Bucket into local-day windows in the user's timezone:
    //   day 0 = today (now → end of today in tz)
    //   day 1 = tomorrow (full calendar day)
    //   day 2 = day after tomorrow (full calendar day)
    const dayBuckets = bucketByLocalDay(reminders, tz, now, DIGEST_DAYS);
    const totalCount = dayBuckets.reduce((sum, b) => sum + b.items.length, 0);

    let intro;
    let recordToGuildId = null;
    try {
        const result = await generateIntro(totalCount, tzNow);
        intro = result.intro;
        recordToGuildId = await resolveRecordingGuild(user);
        if (recordToGuildId) {
            recordUsage(recordToGuildId, user.user_id, result.inputTokens, result.outputTokens, DIGEST_MODEL);
        }
    } catch (err) {
        logger.warn('Secretary: intro generation failed, falling back to default', { userId: user.user_id, error: err.message });
        intro = totalCount > 0
            ? `Good morning! Here's your day:`
            : `Good morning! Nothing on the calendar today — enjoy.`;
    }

    const body = buildDigestBody(intro, dayBuckets, tz);

    // Resolve delivery target
    const target = await resolveDeliveryTarget(user);
    if (!target) {
        logger.warn('Secretary: no usable delivery target', { userId: user.user_id });
        markDigestSent(user.user_id); // still mark sent so we don't retry forever today
        return { success: false, reason: 'no usable delivery target' };
    }

    // Skip if the destination guild is out of credits (only for channel delivery)
    if (target.kind === 'channel' && target.guildId && isGuildOutOfCredits(target.guildId)) {
        logger.info('Secretary: skipping digest, guild out of credits', { userId: user.user_id, guildId: target.guildId });
        markDigestSent(user.user_id);
        return;
    }

    try {
        // Ping ONLY when there's actual reminder content. Empty digests are
        // informational ("nothing on the calendar"), no need to highlight.
        const shouldPing = target.kind === 'channel' && totalCount > 0;
        const text = shouldPing ? `<@${user.user_id}> ${body}` : body;
        await target.sendable.send(text);
        markDigestSent(user.user_id);
        logger.info('Secretary digest sent', {
            userId: user.user_id,
            kind: target.kind,
            reminderCount: totalCount,
            pinged: shouldPing,
        });
        return { success: true, kind: target.kind, reminderCount: totalCount, pinged: shouldPing };
    } catch (err) {
        if (target.kind === 'dm') {
            // Fall back to channel post if DMs are closed
            const fallback = await resolveChannelTarget(user.delivery_channel_id);
            if (fallback) {
                try {
                    const fallbackPing = totalCount > 0 ? `<@${user.user_id}> ${body}` : body;
                    await fallback.sendable.send(fallbackPing);
                    markDigestSent(user.user_id);
                    logger.info('Secretary digest sent via channel fallback', { userId: user.user_id });
                    return { success: true, kind: 'channel', reminderCount: totalCount, pinged: totalCount > 0, fallback: true };
                } catch (e2) {
                    logger.error('Secretary fallback channel send failed', { userId: user.user_id, error: e2.message });
                }
            }
        }
        logger.error('Secretary digest send failed', { userId: user.user_id, error: err.message });
        markDigestSent(user.user_id); // give up — don't retry today
        return { success: false, reason: err.message };
    }
}

/**
 * Bucket a user's reminders into local-day windows in their timezone.
 * Returns an array of { dayIndex, startMs, endMs, items } where:
 *   dayIndex 0 = today (now → end of today in user's tz)
 *   dayIndex 1 = tomorrow (full local calendar day)
 *   dayIndex 2+ = day after (full local calendar day)
 *
 * Items are filtered to fire_at >= now and < endMs of the LAST bucket. Each
 * item is sorted by fire_at within its bucket.
 */
function bucketByLocalDay(reminders, tz, now, days) {
    // Compute "start of today in user's tz" as a UTC instant.
    const tzNow = nowInZone(tz);
    const todayStartLocal = `${pad(tzNow.year, 4)}-${pad(tzNow.month)}-${pad(tzNow.day)} 00:00`;
    let todayStartUtc;
    try {
        todayStartUtc = localToUtc(todayStartLocal, tz);
    } catch {
        todayStartUtc = new Date(now); // best-effort fallback
    }

    const dayMs = 24 * 60 * 60_000;
    const buckets = [];
    for (let i = 0; i < days; i++) {
        const dayStart = todayStartUtc.getTime() + i * dayMs;
        const dayEnd = dayStart + dayMs;
        // For day 0, lower bound is "now" (don't list reminders that already passed today)
        const lowerBound = i === 0 ? Math.max(dayStart, now) : dayStart;
        const items = reminders
            .map(r => ({ row: r, fireMs: parseSqliteUtc(r.fire_at_utc).getTime() }))
            .filter(({ fireMs }) => fireMs >= lowerBound && fireMs < dayEnd)
            .sort((a, b) => a.fireMs - b.fireMs)
            .map(({ row }) => row);
        buckets.push({ dayIndex: i, startMs: dayStart, endMs: dayEnd, items });
    }
    return buckets;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Returns the weekday + short month + day for a UTC instant in a given tz.
 * Used to label day buckets like "Tuesday, Apr 29".
 */
function dayLabel(utcMs, tz) {
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, weekday: 'long', month: 'short', day: 'numeric',
        });
        const parts = fmt.formatToParts(new Date(utcMs));
        const get = (t) => parts.find(p => p.type === t)?.value;
        const weekday = get('weekday');
        const month = get('month');
        const day = get('day');
        return { weekday, month, day, label: `${weekday}, ${month} ${day}` };
    } catch {
        return { weekday: '', month: '', day: '', label: '' };
    }
}

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function buildDigestBody(intro, dayBuckets, tz) {
    let body = `🌅 **${intro}**`;

    const totalCount = dayBuckets.reduce((sum, b) => sum + b.items.length, 0);
    if (totalCount === 0) {
        body += `\n\n_Nothing on the calendar in the next ${DIGEST_DAYS} days._`;
        return body;
    }

    // Today section — includes the date so the user can see it at a glance
    const today = dayBuckets[0];
    if (today && today.items.length > 0) {
        const { month, day } = dayLabel(today.startMs, tz);
        body += `\n\n### 📍 Today, ${month} ${day}\n`;
        body += today.items.map(formatDigestLine).join('\n');
    }

    // Coming up section: days 1..N-1 with sub-headers per day, only days with items
    const upcoming = dayBuckets.slice(1).filter(b => b.items.length > 0);
    if (upcoming.length > 0) {
        body += `\n\n### 📅 Coming up\n`;
        for (const bucket of upcoming) {
            const { label } = dayLabel(bucket.startMs, tz);
            body += `\n**${label}:**\n`;
            body += bucket.items.map(formatDigestLine).join('\n');
        }
    }

    return body;
}

function formatDigestLine(r) {
    const time = discordTimestamp(parseSqliteUtc(r.fire_at_utc), 't');
    const recurringTag = r.recurrence ? ` _(${r.recurrence})_` : '';
    return `• ${time} — ${r.message.slice(0, 100)}${recurringTag}`;
}

async function generateIntro(reminderCount, tzNow) {
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tzNow.weekday];
    const prompt = reminderCount === 0
        ? `Write a single short, warm morning greeting (10 words max). It's ${dayName} morning. The user has nothing scheduled today. No emoji, no quotes, just the greeting.`
        : `Write a single short, warm morning greeting (10 words max). It's ${dayName} morning. The user has ${reminderCount} reminder${reminderCount === 1 ? '' : 's'} on the calendar. No emoji, no quotes, just the greeting.`;

    const response = await anthropic.messages.create({
        model: DIGEST_MODEL,
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
    });

    const intro = response.content[0]?.text?.trim() || `Good morning!`;
    return {
        intro: intro.replace(/^["']|["']$/g, ''), // strip stray quotes if any
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
    };
}

async function resolveDeliveryTarget(user) {
    if (user.delivery_mode === 'dm') {
        try {
            const u = await discordClient.users.fetch(user.user_id);
            const dm = await u.createDM();
            return { kind: 'dm', sendable: dm, guildId: null };
        } catch {
            return null;
        }
    }
    if (user.delivery_mode === 'channel' && user.delivery_channel_id) {
        return await resolveChannelTarget(user.delivery_channel_id);
    }
    return null;
}

async function resolveChannelTarget(channelId) {
    if (!channelId) return null;
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') return null;
        return { kind: 'channel', sendable: channel, guildId: channel.guild?.id };
    } catch {
        return null;
    }
}

async function resolveRecordingGuild(user) {
    // Best effort: charge the digest cost against the guild where the channel lives
    // (if channel mode), otherwise null and the digest cost goes unattributed.
    if (user.delivery_mode === 'channel' && user.delivery_channel_id) {
        try {
            const ch = await discordClient.channels.fetch(user.delivery_channel_id);
            return ch?.guild?.id ?? null;
        } catch {
            return null;
        }
    }
    return null;
}

function sameLocalDay(a, b, tz) {
    const aStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(a);
    const bStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(b);
    return aStr === bStr;
}
