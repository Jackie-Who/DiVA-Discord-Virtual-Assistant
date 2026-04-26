/**
 * Reminder scheduler.
 *
 * Pattern: in-memory timer Map<reminderId, timeoutHandle> for reminders within
 * the next 24h, plus an hourly sweep that re-queries SQLite for any reminders
 * that drift into the 24h window. This keeps the scheduler restart-safe (rebuilt
 * from the DB on boot) without juggling huge setTimeout values.
 *
 * Fire flow:
 *   1. Look up reminder row (verify still pending — wasn't cancelled in flight)
 *   2. Resolve delivery target (DM vs channel)
 *   3. Send the message
 *   4. Mark fired_at = now
 *   5. If recurring, compute next instance and insert + schedule it
 *
 * Cleanup: nightly job deletes fired/cancelled rows older than 30 days, but
 * keeps the recurring "rule" rows as long as they aren't cancelled.
 */

import logger from './logger.js';
import {
    getReminderById,
    getPendingWithinHours,
    markFired,
    insertNextRecurringInstance,
    cleanupExpiredReminders,
} from '../db/reminders.js';
import { getUserSettings } from '../db/userSettings.js';
import { parseSqliteUtc, toSqliteUtc } from './timezone.js';

const SCHEDULE_HORIZON_HOURS = 24;
const SETTIMEOUT_MAX_MS = 2_147_483_647; // ~24.8 days

let discordClient = null;
const activeTimers = new Map(); // reminderId → timeout handle

/**
 * Initialize the scheduler with the Discord client. Loads pending reminders
 * within the next 24h and starts the hourly sweep + nightly cleanup.
 */
export function initReminderScheduler(client) {
    discordClient = client;

    // Initial load — wait until ready so we can fetch channels
    if (client.isReady()) {
        loadAndSchedule();
    } else {
        client.once('ready', () => loadAndSchedule());
    }

    // Hourly sweep: catches any reminder that drifts into the 24h window
    setInterval(() => loadAndSchedule(), 60 * 60 * 1000);

    // Nightly cleanup of old fired/cancelled rows (24h interval, runs once daily)
    setInterval(() => {
        try {
            const deleted = cleanupExpiredReminders(30);
            if (deleted > 0) logger.info('Reminder cleanup', { deleted });
        } catch (err) {
            logger.error('Reminder cleanup failed', { error: err.message });
        }
    }, 24 * 60 * 60 * 1000);

    logger.info('Reminder scheduler initialized');
}

/**
 * Pull every pending reminder firing within the next 24h and schedule a timer
 * for each one we don't already have in memory. Idempotent — safe to call
 * repeatedly (hourly sweep, after restart, after manual top-ups).
 */
function loadAndSchedule() {
    let pending;
    try {
        pending = getPendingWithinHours(SCHEDULE_HORIZON_HOURS);
    } catch (err) {
        logger.error('Reminder load failed', { error: err.message });
        return;
    }

    let scheduled = 0;
    for (const reminder of pending) {
        if (activeTimers.has(reminder.id)) continue; // already scheduled
        scheduleTimer(reminder);
        scheduled++;
    }

    if (scheduled > 0) {
        logger.info('Reminders scheduled', { count: scheduled, totalActive: activeTimers.size });
    }
}

/**
 * Set a timer for one reminder. Caller has already verified it's not in the Map.
 */
function scheduleTimer(reminder) {
    // CRITICAL: fire_at_utc is stored as "YYYY-MM-DD HH:MM:SS" without a Z marker.
    // We must parse it as UTC explicitly — `new Date(str)` would treat it as local time.
    const fireAt = parseSqliteUtc(reminder.fire_at_utc).getTime();
    const ms = Math.max(0, fireAt - Date.now());

    if (ms > SETTIMEOUT_MAX_MS) {
        // Beyond 24.8 days — skip; the hourly sweep will catch it later.
        return;
    }

    const handle = setTimeout(() => {
        activeTimers.delete(reminder.id);
        fireReminder(reminder.id).catch(err =>
            logger.error('fireReminder threw', { reminderId: reminder.id, error: err.message, stack: err.stack })
        );
    }, ms);

    activeTimers.set(reminder.id, handle);
}

/**
 * Fire a single reminder. Re-fetches the row to guard against in-flight cancellation,
 * resolves delivery, sends the message, marks fired, and rebooks for recurring rules.
 */
async function fireReminder(reminderId) {
    const reminder = getReminderById(reminderId);
    if (!reminder) {
        logger.warn('Reminder vanished before firing', { reminderId });
        return;
    }
    if (reminder.cancelled_at) {
        logger.debug('Reminder cancelled in-flight, skipping', { reminderId });
        return;
    }
    if (reminder.fired_at) {
        logger.debug('Reminder already fired, skipping', { reminderId });
        return;
    }
    if (!discordClient) {
        logger.error('Reminder fire attempted before client ready', { reminderId });
        return;
    }

    // Resolve where to send. Recurring reminders use the user's saved delivery
    // preference; one-shots go back to the channel where they were created.
    let target = null; // { kind: 'dm' | 'channel', sendable }

    if (reminder.recurrence) {
        const settings = getUserSettings(reminder.user_id);
        if (settings.deliveryMode === 'dm') {
            target = await resolveDmTarget(reminder.user_id);
        } else if (settings.deliveryMode === 'channel' && settings.deliveryChannelId) {
            target = await resolveChannelTarget(settings.deliveryChannelId);
        } else {
            // Fallback to the channel the rule was originally created in
            target = await resolveChannelTarget(reminder.channel_id);
        }
    } else {
        // One-shot — post in original channel
        target = await resolveChannelTarget(reminder.channel_id);
    }

    if (!target) {
        logger.warn('No deliverable target for reminder', { reminderId, userId: reminder.user_id });
        // Still mark as fired so we don't retry forever
        markFired(reminderId);
        return;
    }

    const body = formatReminderMessage(reminder);
    // Ping the user when posting in a channel; in a DM the user IS the recipient
    // and Discord doesn't render @mentions in DMs anyway.
    const text = target.kind === 'channel' ? `<@${reminder.user_id}> ${body}` : body;

    try {
        await target.sendable.send(text);
        markFired(reminderId);
        logger.info('Reminder fired', {
            reminderId,
            userId: reminder.user_id,
            kind: reminder.recurrence || 'one-shot',
            target: target.kind,
        });
    } catch (err) {
        // If DM failed, fall back to channel post (with the ping)
        if (target.kind === 'dm') {
            const fallback = await resolveChannelTarget(reminder.channel_id);
            if (fallback) {
                try {
                    await fallback.sendable.send(`<@${reminder.user_id}> ${body}`);
                    markFired(reminderId);
                    logger.info('Reminder fired via channel fallback (DM closed)', { reminderId });
                } catch (e2) {
                    logger.error('Reminder fallback channel send failed', { reminderId, error: e2.message });
                    markFired(reminderId); // give up — don't retry forever
                }
            } else {
                logger.error('Reminder DM and fallback both failed', { reminderId, error: err.message });
                markFired(reminderId);
            }
        } else {
            logger.error('Reminder send failed', { reminderId, error: err.message });
            markFired(reminderId);
        }
    }

    // Reboot for recurring rules
    if (reminder.recurrence) {
        try {
            await scheduleNextRecurringInstance(reminder);
        } catch (err) {
            logger.error('Failed to schedule next recurring instance', {
                reminderId,
                parentId: reminder.parent_id,
                error: err.message,
            });
        }
    }
}

/**
 * Compute and insert the next instance of a recurring rule, then schedule it.
 *
 * For 'daily': next fire is tomorrow at the same fire_time_local.
 * For 'weekly': next fire is 7 days from this firing.
 * Both use the user's tz to compute the local time, then convert to UTC.
 */
async function scheduleNextRecurringInstance(reminder) {
    const settings = getUserSettings(reminder.user_id);
    if (!settings.timezone) {
        logger.warn('Cannot schedule next recurring — user lost timezone', { reminderId: reminder.id });
        return;
    }

    const intervalDays = reminder.recurrence === 'weekly' ? 7 : 1;
    const lastFire = parseSqliteUtc(reminder.fire_at_utc);
    const nextUtc = new Date(lastFire.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    const nextUtcIso = toSqliteUtc(nextUtc);

    const newId = insertNextRecurringInstance({
        parentId: reminder.parent_id || reminder.id,
        guildId: reminder.guild_id,
        channelId: reminder.channel_id,
        userId: reminder.user_id,
        fireAtUtc: nextUtcIso,
        message: reminder.message,
        recurrence: reminder.recurrence,
        weekday: reminder.weekday,
        fireTimeLocal: reminder.fire_time_local,
    });

    // Schedule it if it's within our 24h horizon (otherwise the hourly sweep picks it up)
    const newRow = getReminderById(newId);
    if (newRow) scheduleTimer(newRow);

    logger.debug('Recurring instance scheduled', {
        ruleId: reminder.parent_id || reminder.id,
        nextInstanceId: newId,
        fireAtUtc: nextUtcIso,
    });
}

function formatReminderMessage(reminder) {
    const prefix = reminder.recurrence ? '🔁' : '⏰';
    return `${prefix} **Reminder:** ${reminder.message}`;
}

async function resolveDmTarget(userId) {
    try {
        const user = await discordClient.users.fetch(userId);
        if (!user) return null;
        const dm = await user.createDM();
        return { kind: 'dm', sendable: dm };
    } catch {
        return null;
    }
}

async function resolveChannelTarget(channelId) {
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return null;
        if (typeof channel.send !== 'function') return null;
        return { kind: 'channel', sendable: channel };
    } catch {
        return null;
    }
}

/**
 * Cancel an in-memory timer (call after marking the row cancelled).
 */
export function cancelTimer(reminderId) {
    const handle = activeTimers.get(reminderId);
    if (handle) {
        clearTimeout(handle);
        activeTimers.delete(reminderId);
    }
}

/**
 * Re-schedule an in-memory timer (e.g., after a reschedule operation).
 * Cancels any existing timer for the reminder, then schedules afresh from DB.
 */
export function rescheduleTimer(reminderId) {
    cancelTimer(reminderId);
    const row = getReminderById(reminderId);
    if (!row || row.fired_at || row.cancelled_at) return;
    scheduleTimer(row);
}

/**
 * Manually schedule a freshly-created reminder (called from tool execution).
 */
export function scheduleNewReminder(reminderId) {
    const row = getReminderById(reminderId);
    if (!row || row.fired_at || row.cancelled_at) return;
    if (activeTimers.has(reminderId)) return;
    scheduleTimer(row);
}
