/**
 * Reminder scheduler.
 *
 * Three kinds of timers per reminder, all kept in separate in-memory Maps:
 *   1. activeTimers       → fires the actual reminder at fire_at_utc
 *   2. preFireTimers      → fires a "heads up" notification 1 hour before
 *   3. snoozeTimers       → fires a "30 minutes left" follow-up if user clicked Snooze
 *
 * Pre-fire policy:
 *   - Recurring (daily/weekly): every instance gets a pre-fire at fire_at - 1h
 *   - One-shot: pre-fire ONLY if fire_at is at least 3h from "now" (avoids
 *     pre-fires that would land seconds after the user creates the reminder)
 *
 * Persistence:
 *   - actual fires:  fire_at_utc column (existing)
 *   - pre-fires:     computed as fire_at_utc - 1h (no separate column)
 *   - snoozes:       snooze_until_utc column on reminders table (added in v1.2.1)
 *
 * Restart-safe: loadAndSchedule() rebuilds all three Maps from SQLite on bot
 * startup. Hourly sweep keeps the in-memory state in sync.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} from 'discord.js';
import logger from './logger.js';
import {
    getReminderById,
    getPendingWithinHours,
    markFired,
    insertNextRecurringInstance,
    cleanupExpiredReminders,
    dismissReminderInstance,
    setSnoozeUntil,
    clearSnooze,
    getActiveSnoozes,
} from '../db/reminders.js';
import { getUserSettings } from '../db/userSettings.js';
import { parseSqliteUtc, toSqliteUtc, discordTimestamp } from './timezone.js';

const SCHEDULE_HORIZON_HOURS = 24;
const SETTIMEOUT_MAX_MS = 2_147_483_647; // ~24.8 days

// Pre-fire policy (overridable via env vars for dev testing fast-cycles)
const PRE_FIRE_OFFSET_MS = parseInt(process.env.PRE_FIRE_OFFSET_MS, 10) || 60 * 60 * 1000;          // 1 hour before actual fire
const SNOOZE_OFFSET_MS = parseInt(process.env.SNOOZE_OFFSET_MS, 10) || 30 * 60 * 1000;             // snooze ping at fire_at - 30min
const ONE_SHOT_PRE_FIRE_THRESHOLD_MS = parseInt(process.env.PRE_FIRE_THRESHOLD_MS, 10) || 3 * 60 * 60 * 1000; // 3h minimum lead

let discordClient = null;
const activeTimers = new Map();   // reminderId → actual-fire timeout handle
const preFireTimers = new Map();  // reminderId → pre-fire timeout handle
const snoozeTimers = new Map();   // reminderId → snooze (T-30) timeout handle

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
 * Pull every pending reminder firing within the next 24h and schedule timers
 * for actual fires + pre-fires. Also load active snoozes. Idempotent.
 */
function loadAndSchedule() {
    let pending;
    try {
        pending = getPendingWithinHours(SCHEDULE_HORIZON_HOURS);
    } catch (err) {
        logger.error('Reminder load failed', { error: err.message });
        return;
    }

    let scheduledFires = 0;
    let scheduledPreFires = 0;
    for (const reminder of pending) {
        if (!activeTimers.has(reminder.id)) {
            scheduleActualFire(reminder);
            scheduledFires++;
        }
        if (!preFireTimers.has(reminder.id)) {
            if (schedulePreFireIfApplicable(reminder)) scheduledPreFires++;
        }
    }

    // Load active snoozes (snooze_until_utc set, pending)
    let scheduledSnoozes = 0;
    try {
        const snoozes = getActiveSnoozes();
        for (const reminder of snoozes) {
            if (!snoozeTimers.has(reminder.id)) {
                if (scheduleSnoozeFire(reminder)) scheduledSnoozes++;
            }
        }
    } catch (err) {
        logger.error('Snooze load failed', { error: err.message });
    }

    if (scheduledFires + scheduledPreFires + scheduledSnoozes > 0) {
        logger.info('Reminders scheduled', {
            actualFires: scheduledFires,
            preFires: scheduledPreFires,
            snoozes: scheduledSnoozes,
            totalActive: activeTimers.size,
        });
    }
}

// ── Actual fire (the reminder itself) ──

/**
 * Set a timer to fire the actual reminder at fire_at_utc.
 */
function scheduleActualFire(reminder) {
    const fireAt = parseSqliteUtc(reminder.fire_at_utc).getTime();
    const ms = Math.max(0, fireAt - Date.now());

    if (ms > SETTIMEOUT_MAX_MS) return; // hourly sweep will catch it later

    const handle = setTimeout(() => {
        activeTimers.delete(reminder.id);
        fireReminder(reminder.id).catch(err =>
            logger.error('fireReminder threw', { reminderId: reminder.id, error: err.message, stack: err.stack })
        );
    }, ms);

    activeTimers.set(reminder.id, handle);
}

/**
 * Fire the actual reminder. Re-fetches the row to guard against in-flight
 * cancellation, resolves delivery, sends the ping, marks fired, rebooks
 * recurring instance.
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

    // Clear any leftover pre-fire / snooze timers (they're moot now)
    cancelPreFireTimer(reminderId);
    cancelSnoozeTimer(reminderId);

    const target = await resolveTargetForReminder(reminder);
    if (!target) {
        logger.warn('No deliverable target for reminder', { reminderId, userId: reminder.user_id });
        markFired(reminderId);
        return;
    }

    const body = formatActualFireMessage(reminder);
    const text = target.kind === 'channel' ? `<@${reminder.user_id}> ${body}` : body;

    try {
        await target.sendable.send(text);
        markFired(reminderId);
        logger.info('Reminder fired', {
            reminderId, userId: reminder.user_id,
            kind: reminder.recurrence || 'one-shot', target: target.kind,
        });
    } catch (err) {
        if (target.kind === 'dm') {
            // Fall back to channel post if DMs are closed
            const fallback = await resolveChannelTarget(reminder.channel_id);
            if (fallback) {
                try {
                    await fallback.sendable.send(`<@${reminder.user_id}> ${body}`);
                    markFired(reminderId);
                    logger.info('Reminder fired via channel fallback (DM closed)', { reminderId });
                } catch (e2) {
                    logger.error('Reminder fallback channel send failed', { reminderId, error: e2.message });
                    markFired(reminderId);
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
                reminderId, parentId: reminder.parent_id, error: err.message,
            });
        }
    }
}

// ── Pre-fire (heads-up 1 hour before) ──

/**
 * Schedule the pre-fire timer if applicable per policy:
 *   - Recurring: always (as long as pre-fire instant is in the future)
 *   - One-shot: only if fire_at is at least 3h from now
 * Returns true if scheduled, false if skipped.
 */
function schedulePreFireIfApplicable(reminder) {
    const fireAt = parseSqliteUtc(reminder.fire_at_utc).getTime();
    const now = Date.now();
    const lead = fireAt - now;

    // Recurring: pre-fire iff at least PRE_FIRE_OFFSET_MS+a bit of lead
    // One-shot: 3h threshold
    if (reminder.recurrence) {
        if (lead <= PRE_FIRE_OFFSET_MS) return false; // pre-fire would be in the past
    } else {
        if (lead < ONE_SHOT_PRE_FIRE_THRESHOLD_MS) return false; // policy: short one-shots skip pre-fire
    }

    const preFireMs = lead - PRE_FIRE_OFFSET_MS;
    if (preFireMs > SETTIMEOUT_MAX_MS) return false; // hourly sweep will catch it

    const handle = setTimeout(() => {
        preFireTimers.delete(reminder.id);
        firePreFire(reminder.id).catch(err =>
            logger.error('firePreFire threw', { reminderId: reminder.id, error: err.message, stack: err.stack })
        );
    }, preFireMs);

    preFireTimers.set(reminder.id, handle);
    return true;
}

/**
 * Send the pre-fire heads-up message with [Snooze] [Dismiss] buttons.
 * Button clicks are routed via the global interactionCreate handler so they
 * survive bot restarts.
 */
async function firePreFire(reminderId) {
    const reminder = getReminderById(reminderId);
    if (!reminder || reminder.fired_at || reminder.cancelled_at) {
        logger.debug('Pre-fire skipped — reminder no longer pending', { reminderId });
        return;
    }
    if (!discordClient) return;

    const target = await resolveTargetForReminder(reminder);
    if (!target) {
        logger.warn('No deliverable target for pre-fire', { reminderId });
        return;
    }

    const body = formatPreFireMessage(reminder);
    const text = target.kind === 'channel' ? `<@${reminder.user_id}> ${body}` : body;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`prefire_snooze_${reminder.id}`)
            .setLabel('Snooze 30 min')
            .setEmoji('💤')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`prefire_dismiss_${reminder.id}`)
            .setLabel('Dismiss')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Danger),
    );

    try {
        await target.sendable.send({ content: text, components: [row] });
        logger.info('Pre-fire posted', { reminderId, userId: reminder.user_id, target: target.kind });
    } catch (err) {
        logger.warn('Pre-fire send failed', { reminderId, error: err.message });
    }
}

function formatPreFireMessage(reminder) {
    const fireAt = parseSqliteUtc(reminder.fire_at_utc);
    return `🔔 **Heads up** — coming up ${discordTimestamp(fireAt, 'R')} (${discordTimestamp(fireAt, 't')}):\n> ${reminder.message}`;
}

function cancelPreFireTimer(reminderId) {
    const handle = preFireTimers.get(reminderId);
    if (handle) {
        clearTimeout(handle);
        preFireTimers.delete(reminderId);
    }
}

// ── Snooze (T-30 follow-up after user clicks Snooze on pre-fire) ──

/**
 * Schedule the snooze timer based on the row's snooze_until_utc column.
 * Returns true if scheduled.
 */
function scheduleSnoozeFire(reminder) {
    if (!reminder.snooze_until_utc) return false;
    const snoozeAt = parseSqliteUtc(reminder.snooze_until_utc).getTime();
    const now = Date.now();
    if (snoozeAt <= now) {
        // Snooze should have fired already — clear and skip
        clearSnooze(reminder.id);
        return false;
    }
    const ms = snoozeAt - now;
    if (ms > SETTIMEOUT_MAX_MS) return false; // unlikely (snooze is at most 30 min from now)

    const handle = setTimeout(() => {
        snoozeTimers.delete(reminder.id);
        fireSnooze(reminder.id).catch(err =>
            logger.error('fireSnooze threw', { reminderId: reminder.id, error: err.message, stack: err.stack })
        );
    }, ms);

    snoozeTimers.set(reminder.id, handle);
    return true;
}

/**
 * Send the T-30 snooze ping with [Dismiss] button only.
 */
async function fireSnooze(reminderId) {
    const reminder = getReminderById(reminderId);
    if (!reminder || reminder.fired_at || reminder.cancelled_at) {
        logger.debug('Snooze skipped — reminder no longer pending', { reminderId });
        clearSnooze(reminderId);
        return;
    }
    if (!discordClient) return;

    const target = await resolveTargetForReminder(reminder);
    if (!target) {
        logger.warn('No deliverable target for snooze', { reminderId });
        clearSnooze(reminderId);
        return;
    }

    const fireAt = parseSqliteUtc(reminder.fire_at_utc);
    const body = `🔔 **30 minutes** until ${discordTimestamp(fireAt, 't')}:\n> ${reminder.message}`;
    const text = target.kind === 'channel' ? `<@${reminder.user_id}> ${body}` : body;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`prefire_dismiss_${reminder.id}`)
            .setLabel('Dismiss')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Danger),
    );

    try {
        await target.sendable.send({ content: text, components: [row] });
        clearSnooze(reminderId);
        logger.info('Snooze ping posted', { reminderId, userId: reminder.user_id });
    } catch (err) {
        logger.warn('Snooze send failed', { reminderId, error: err.message });
        clearSnooze(reminderId);
    }
}

function cancelSnoozeTimer(reminderId) {
    const handle = snoozeTimers.get(reminderId);
    if (handle) {
        clearTimeout(handle);
        snoozeTimers.delete(reminderId);
    }
}

// ── Pre-fire button handlers (called from interactionCreate global router) ──

/**
 * Handle a click on a "prefire_*" button. Custom IDs are formatted:
 *   prefire_<action>_<reminderId>
 * where <action> is 'snooze' or 'dismiss'.
 *
 * Updates the message in-place to disable the clicked button (and Snooze, on
 * dismiss). All button interactions go through this handler so they survive
 * bot restarts.
 */
export async function handlePreFireButton(interaction) {
    const parts = interaction.customId.split('_');
    if (parts.length < 3 || parts[0] !== 'prefire') return;
    const action = parts[1];
    const reminderId = parseInt(parts[2], 10);
    if (!Number.isInteger(reminderId)) return;

    const reminder = getReminderById(reminderId);

    if (!reminder) {
        await interaction.reply({
            content: 'This reminder no longer exists.',
            flags: MessageFlags.Ephemeral,
        });
        await disableComponentsOnReply(interaction).catch(() => {});
        return;
    }
    if (reminder.user_id !== interaction.user.id) {
        await interaction.reply({
            content: 'This is someone else\'s reminder — only they can interact with it.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    if (reminder.fired_at) {
        await interaction.reply({
            content: 'This reminder has already fired.',
            flags: MessageFlags.Ephemeral,
        });
        await disableComponentsOnReply(interaction).catch(() => {});
        return;
    }
    if (reminder.cancelled_at) {
        await interaction.reply({
            content: 'This reminder has already been cancelled.',
            flags: MessageFlags.Ephemeral,
        });
        await disableComponentsOnReply(interaction).catch(() => {});
        return;
    }

    if (action === 'dismiss') {
        return handleDismissClick(interaction, reminder);
    }
    if (action === 'snooze') {
        return handleSnoozeClick(interaction, reminder);
    }
}

/**
 * Dismiss action — cancels this reminder instance. For recurring rules, also
 * inserts and schedules the next instance so the rule keeps going.
 */
async function handleDismissClick(interaction, reminder) {
    const dismissed = dismissReminderInstance(reminder.id, reminder.user_id);
    if (!dismissed) {
        await interaction.reply({
            content: 'Could not dismiss — the reminder may have changed state.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Stop all pending timers for this row
    cancelTimer(reminder.id);
    cancelPreFireTimer(reminder.id);
    cancelSnoozeTimer(reminder.id);

    // For recurring: insert and schedule the next instance so the rule continues
    if (dismissed.recurrence) {
        try {
            await scheduleNextRecurringInstance(dismissed);
        } catch (err) {
            logger.error('Failed to schedule next recurring instance after dismiss', {
                reminderId: reminder.id, error: err.message,
            });
        }
    }

    const isRecurring = !!dismissed.recurrence;
    const reply = isRecurring
        ? `✖️ Dismissed this instance of "${reminder.message.slice(0, 60)}". The recurring rule keeps going for the next one.`
        : `✖️ Dismissed reminder "${reminder.message.slice(0, 60)}".`;

    try {
        await interaction.update({
            content: interaction.message.content + `\n\n${reply}`,
            components: disableAllComponents(interaction.message.components),
        });
    } catch (err) {
        logger.warn('Failed to update message after dismiss', { error: err.message });
    }
    logger.info('Reminder dismissed via pre-fire button', {
        reminderId: reminder.id, userId: reminder.user_id, recurring: isRecurring,
    });
}

/**
 * Snooze action — schedules a follow-up ping at fire_at - 30min.
 */
async function handleSnoozeClick(interaction, reminder) {
    const fireAt = parseSqliteUtc(reminder.fire_at_utc).getTime();
    const snoozeAt = fireAt - SNOOZE_OFFSET_MS;
    const now = Date.now();

    if (snoozeAt <= now) {
        await interaction.reply({
            content: 'Too close to the fire time to snooze (snooze pings at 30 minutes before — that\'s already past). Use Dismiss if you want to cancel.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const ok = setSnoozeUntil(reminder.id, reminder.user_id, toSqliteUtc(new Date(snoozeAt)));
    if (!ok) {
        await interaction.reply({
            content: 'Could not snooze — the reminder may have changed state.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Cancel any prior snooze timer (rare — user clicked twice somehow)
    cancelSnoozeTimer(reminder.id);
    const refreshed = getReminderById(reminder.id);
    scheduleSnoozeFire(refreshed);

    try {
        await interaction.update({
            content: interaction.message.content + `\n\n💤 Snoozed — I'll ping again ${discordTimestamp(new Date(snoozeAt), 'R')}.`,
            components: disableAllComponents(interaction.message.components),
        });
    } catch (err) {
        logger.warn('Failed to update message after snooze', { error: err.message });
    }
    logger.info('Reminder snoozed via pre-fire button', {
        reminderId: reminder.id, userId: reminder.user_id,
    });
}

/**
 * Disable all components on the source message of an interaction.
 * Used when the user clicks a button on a stale (already-fired/cancelled) message.
 */
async function disableComponentsOnReply(interaction) {
    if (!interaction.message?.components?.length) return;
    try {
        await interaction.message.edit({
            components: disableAllComponents(interaction.message.components),
        });
    } catch {
        // Stale message may not be editable; that's fine
    }
}

function disableAllComponents(rows) {
    return rows.map(row => {
        const newRow = ActionRowBuilder.from(row);
        newRow.setComponents(
            row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
        );
        return newRow;
    });
}

// ── Recurring rebook (used by both fire + dismiss) ──

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

    const newRow = getReminderById(newId);
    if (newRow) {
        scheduleActualFire(newRow);
        schedulePreFireIfApplicable(newRow);
    }

    logger.debug('Recurring instance scheduled', {
        ruleId: reminder.parent_id || reminder.id,
        nextInstanceId: newId,
        fireAtUtc: nextUtcIso,
    });
}

// ── Target resolution (DM vs channel) ──

async function resolveTargetForReminder(reminder) {
    if (reminder.recurrence) {
        const settings = getUserSettings(reminder.user_id);
        if (settings.deliveryMode === 'dm') return resolveDmTarget(reminder.user_id);
        if (settings.deliveryMode === 'channel' && settings.deliveryChannelId) {
            return resolveChannelTarget(settings.deliveryChannelId);
        }
        return resolveChannelTarget(reminder.channel_id);
    }
    return resolveChannelTarget(reminder.channel_id);
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

function formatActualFireMessage(reminder) {
    const prefix = reminder.recurrence ? '🔁' : '⏰';
    return `${prefix} **Reminder:** ${reminder.message}`;
}

// ── Public API for tool handlers ──

/**
 * Cancel ALL timers (actual + pre-fire + snooze) for a reminder.
 * Call after marking the row cancelled in DB.
 */
export function cancelTimer(reminderId) {
    const handle = activeTimers.get(reminderId);
    if (handle) {
        clearTimeout(handle);
        activeTimers.delete(reminderId);
    }
    cancelPreFireTimer(reminderId);
    cancelSnoozeTimer(reminderId);
}

/**
 * Re-schedule timers after a reschedule operation. Cancels old timers, clears
 * any active snooze (since the snooze was for the old fire time), then
 * re-schedules from the updated DB row.
 */
export function rescheduleTimer(reminderId) {
    cancelTimer(reminderId); // also clears pre-fire and snooze
    clearSnooze(reminderId);
    const row = getReminderById(reminderId);
    if (!row || row.fired_at || row.cancelled_at) return;
    scheduleActualFire(row);
    schedulePreFireIfApplicable(row);
}

/**
 * Schedule timers for a freshly-created reminder.
 */
export function scheduleNewReminder(reminderId) {
    const row = getReminderById(reminderId);
    if (!row || row.fired_at || row.cancelled_at) return;
    if (!activeTimers.has(reminderId)) scheduleActualFire(row);
    if (!preFireTimers.has(reminderId)) schedulePreFireIfApplicable(row);
}
