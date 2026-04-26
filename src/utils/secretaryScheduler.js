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
const DIGEST_HORIZON_HOURS = 48;
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

    // Check the user's primary guild for credit (digests cost API calls)
    // We approximate by using the delivery channel's guild if a channel is set,
    // otherwise we use any guild they're known in. Simplest: skip the credit
    // check for digests — they're cheap enough that running them is fine even
    // when other AI features are paused. (We still record usage against the
    // delivery guild if known, so it counts toward that guild's spend.)

    const reminders = getActiveRemindersForUser(user.user_id);
    const horizonMs = now + DIGEST_HORIZON_HOURS * 60 * 60_000;
    const upcoming = reminders.filter(r => {
        const fire = parseSqliteUtc(r.fire_at_utc).getTime();
        return fire >= now && fire <= horizonMs;
    }).sort((a, b) =>
        parseSqliteUtc(a.fire_at_utc).getTime() - parseSqliteUtc(b.fire_at_utc).getTime()
    );

    let intro;
    let recordToGuildId = null;
    try {
        const result = await generateIntro(upcoming.length, tzNow);
        intro = result.intro;
        recordToGuildId = await resolveRecordingGuild(user);
        if (recordToGuildId) {
            recordUsage(recordToGuildId, user.user_id, result.inputTokens, result.outputTokens, DIGEST_MODEL);
        }
    } catch (err) {
        logger.warn('Secretary: intro generation failed, falling back to default', { userId: user.user_id, error: err.message });
        intro = upcoming.length > 0
            ? `Good morning! Here's your day:`
            : `Good morning! Nothing on the calendar today — enjoy.`;
    }

    const body = buildDigestBody(intro, upcoming);

    // Resolve delivery target
    const target = await resolveDeliveryTarget(user);
    if (!target) {
        logger.warn('Secretary: no usable delivery target', { userId: user.user_id });
        markDigestSent(user.user_id); // still mark sent so we don't retry forever today
        return;
    }

    // Skip if the destination guild is out of credits (only for channel delivery)
    if (target.kind === 'channel' && target.guildId && isGuildOutOfCredits(target.guildId)) {
        logger.info('Secretary: skipping digest, guild out of credits', { userId: user.user_id, guildId: target.guildId });
        markDigestSent(user.user_id);
        return;
    }

    try {
        // For channel delivery, ping the user
        const text = target.kind === 'channel'
            ? `<@${user.user_id}> ${body}`
            : body;
        await target.sendable.send(text);
        markDigestSent(user.user_id);
        logger.info('Secretary digest sent', {
            userId: user.user_id,
            kind: target.kind,
            reminderCount: upcoming.length,
        });
    } catch (err) {
        if (target.kind === 'dm') {
            // Fall back to channel post if DMs are closed
            const fallback = await resolveChannelTarget(user.delivery_channel_id);
            if (fallback) {
                try {
                    await fallback.sendable.send(`<@${user.user_id}> ${body}`);
                    markDigestSent(user.user_id);
                    logger.info('Secretary digest sent via channel fallback', { userId: user.user_id });
                    return;
                } catch (e2) {
                    logger.error('Secretary fallback channel send failed', { userId: user.user_id, error: e2.message });
                }
            }
        }
        logger.error('Secretary digest send failed', { userId: user.user_id, error: err.message });
        markDigestSent(user.user_id); // give up — don't retry today
    }
}

function buildDigestBody(intro, upcoming) {
    let body = `🌅 **${intro}**`;
    if (upcoming.length === 0) {
        body += '\n\n_Nothing on the calendar in the next 48 hours._';
        return body;
    }

    const todayList = [];
    const laterList = [];
    const dayMs = 24 * 60 * 60_000;
    const now = Date.now();
    for (const r of upcoming) {
        const fireMs = parseSqliteUtc(r.fire_at_utc).getTime();
        const within24h = (fireMs - now) <= dayMs;
        const line = `• ${discordTimestamp(parseSqliteUtc(r.fire_at_utc), 't')} — ${r.message.slice(0, 100)}${r.recurrence ? ` _(${r.recurrence})_` : ''}`;
        (within24h ? todayList : laterList).push(line);
    }

    if (todayList.length > 0) {
        body += `\n\n**Today:**\n${todayList.join('\n')}`;
    }
    if (laterList.length > 0) {
        body += `\n\n**Coming up (next 48h):**\n${laterList.join('\n')}`;
    }
    return body;
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

function pad(n, len = 2) { return String(n).padStart(len, '0'); }
