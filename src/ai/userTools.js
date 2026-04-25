/**
 * User tools — available to ALL users (not just admins) via the AI tool system.
 *
 * Currently only reminders. Each write tool routes through the same
 * confirmation flow that admin tools use (✅/❌ buttons in chat.js).
 *
 * Tool list:
 *   - set_reminder           (one-shot)            ← write, confirm
 *   - set_recurring_reminder (daily/weekly only)   ← write, confirm
 *   - list_my_reminders      (read-only)           ← no confirm
 *   - cancel_reminder        (id or fuzzy query)   ← write, confirm
 *   - reschedule_reminder                          ← write, confirm
 */

import logger from '../utils/logger.js';
import { localToUtc, formatLocal, toSqliteUtc, isValidIANAZone, discordTimestamp } from '../utils/timezone.js';
import { getUserSettings } from '../db/userSettings.js';
import {
    createOneShot,
    createRecurring,
    cancelReminder,
    rescheduleOneShot,
    rescheduleRecurring,
    findActiveByQuery,
    getReminderById,
    getActiveRemindersForUser,
} from '../db/reminders.js';
import { scheduleNewReminder, cancelTimer, rescheduleTimer } from '../utils/reminderScheduler.js';

// ── Tool schemas (Anthropic tool_use format) ──

export const USER_TOOL_DEFINITIONS = [
    {
        name: 'set_reminder',
        description: 'Schedule a one-shot reminder for the current user. The user MUST have set their timezone via /timezone first. Posts in the channel where the reminder was set, at the requested local time.',
        input_schema: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The reminder text (max 500 chars).',
                },
                fire_at_local: {
                    type: 'string',
                    description: 'When to fire, in the USER\'S local timezone, formatted "YYYY-MM-DD HH:MM" (24-hour). Compute this from "now" in their timezone (provided in the system prompt) plus their stated offset (e.g. "tomorrow at 9am" → tomorrow\'s date + "09:00").',
                },
            },
            required: ['message', 'fire_at_local'],
        },
    },
    {
        name: 'set_recurring_reminder',
        description: 'Schedule a recurring (daily or weekly) reminder for the current user. Requires the user to have run /secretary on first to configure delivery preferences (DM vs channel). Recurring reminders are LIMITED to "daily" and "weekly" only — never accept "every hour", "every month", "every 5 minutes", etc.',
        input_schema: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The reminder text (max 500 chars).',
                },
                recurrence: {
                    type: 'string',
                    enum: ['daily', 'weekly'],
                    description: 'Either "daily" or "weekly". No other values accepted.',
                },
                weekday: {
                    type: 'integer',
                    description: 'For weekly recurrence ONLY: 0=Sunday, 1=Monday, ..., 6=Saturday. Omit for daily.',
                    minimum: 0,
                    maximum: 6,
                },
                fire_time_local: {
                    type: 'string',
                    description: 'Time of day in HH:MM (24-hour) in the user\'s local timezone. e.g. "08:00" for 8am.',
                },
            },
            required: ['message', 'recurrence', 'fire_time_local'],
        },
    },
    {
        name: 'list_my_reminders',
        description: 'List the current user\'s active (pending) reminders, including IDs they can use for cancel/reschedule.',
        input_schema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'cancel_reminder',
        description: 'Cancel an active reminder. Pass either `id` (preferred — visible in /reminder list) OR `query` (fuzzy match on the reminder text). If the query matches multiple, the tool returns a disambiguation list; ask the user which one.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'Reminder ID (from /reminder list).' },
                query: { type: 'string', description: 'A fuzzy match string — looks in reminder text. Use only if the user didn\'t give an ID.' },
            },
        },
    },
    {
        name: 'reschedule_reminder',
        description: 'Move a reminder to a new time. For one-shots, pass `new_fire_at_local`. For recurring, pass `new_fire_time_local` (and optionally `new_weekday` to change the day of the week for weekly rules). Pass either `id` OR `query` to identify the reminder.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'Reminder ID.' },
                query: { type: 'string', description: 'Fuzzy match string.' },
                new_fire_at_local: { type: 'string', description: '"YYYY-MM-DD HH:MM" — for one-shots only.' },
                new_fire_time_local: { type: 'string', description: '"HH:MM" — for recurring rules only.' },
                new_weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'New weekday for weekly recurrence (0=Sun..6=Sat).' },
            },
        },
    },
];

const USER_TOOLS = new Set(USER_TOOL_DEFINITIONS.map(t => t.name));
const USER_READ_ONLY_TOOLS = new Set(['list_my_reminders']);

export function isUserTool(name) { return USER_TOOLS.has(name); }
export function isReadOnlyUserTool(name) { return USER_READ_ONLY_TOOLS.has(name); }

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Confirmation card formatter ──

export function formatUserToolForConfirmation(toolName, input, userId) {
    const tz = getUserSettings(userId).timezone || 'UTC';

    switch (toolName) {
        case 'set_reminder': {
            try {
                const utc = localToUtc(input.fire_at_local, tz);
                // Discord renders these in the viewer's own locale + timezone
                return `⏰ **Reminder:** _"${truncate(input.message, 80)}"_\n→ ${discordTimestamp(utc, 'F')} (${discordTimestamp(utc, 'R')})`;
            } catch {
                return `⏰ Reminder: _"${truncate(input.message, 80)}"_ at ${input.fire_at_local} (${tz})`;
            }
        }
        case 'set_recurring_reminder': {
            const when = input.recurrence === 'weekly' && input.weekday !== undefined
                ? `every ${WEEKDAY_NAMES[input.weekday]} at ${input.fire_time_local}`
                : `every day at ${input.fire_time_local}`;
            return `🔁 **Recurring reminder:** _"${truncate(input.message, 80)}"_\n→ ${when} (${tz})`;
        }
        case 'cancel_reminder': {
            if (input.id) {
                const r = getReminderById(input.id);
                if (r && r.user_id === userId) {
                    const when = r.recurrence
                        ? ''
                        : ` (${discordTimestamp(new Date(r.fire_at_utc), 'R')})`;
                    return `🗑️ **Cancel reminder #${input.id}:** _"${truncate(r.message, 80)}"_${r.recurrence ? ` (${r.recurrence})` : when}`;
                }
                return `🗑️ Cancel reminder #${input.id}`;
            }
            return `🗑️ Cancel reminders matching "${truncate(input.query || '', 60)}"`;
        }
        case 'reschedule_reminder': {
            const id = input.id ? `#${input.id}` : `matching "${truncate(input.query || '', 60)}"`;
            let newWhen = '';
            if (input.new_fire_at_local) {
                try {
                    const newUtc = localToUtc(input.new_fire_at_local, tz);
                    newWhen = `→ ${discordTimestamp(newUtc, 'F')} (${discordTimestamp(newUtc, 'R')})`;
                } catch {
                    newWhen = `→ ${input.new_fire_at_local} (${tz})`;
                }
            } else if (input.new_fire_time_local) {
                newWhen = `→ every ${input.new_weekday !== undefined ? WEEKDAY_NAMES[input.new_weekday] : 'day'} at ${input.new_fire_time_local}`;
            }
            return `✏️ **Reschedule reminder ${id}**\n${newWhen}`;
        }
        default:
            return `Unknown tool: ${toolName}`;
    }
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── Executor ──

/**
 * Execute a user tool. `message` provides guild + channel context for one-shots.
 * Returns { success: bool, message: string }
 */
export async function executeUserTool(toolName, input, message, userId) {
    if (!USER_TOOLS.has(toolName)) {
        return { success: false, message: `Tool "${toolName}" is not a recognized user tool.` };
    }

    const settings = getUserSettings(userId);

    try {
        switch (toolName) {
            case 'set_reminder':                return await doSetReminder(input, message, userId, settings);
            case 'set_recurring_reminder':      return await doSetRecurring(input, message, userId, settings);
            case 'list_my_reminders':           return doListMine(userId, settings);
            case 'cancel_reminder':             return doCancel(input, userId);
            case 'reschedule_reminder':         return doReschedule(input, userId, settings);
            default:
                return { success: false, message: `Unknown tool: ${toolName}` };
        }
    } catch (err) {
        logger.error('User tool failed', { toolName, error: err.message, stack: err.stack });
        return { success: false, message: `Failed to ${toolName.replace(/_/g, ' ')}: ${err.message}` };
    }
}

// ── Tool bodies ──

function doListMine(userId, _settings) {
    const rows = getActiveRemindersForUser(userId);
    if (rows.length === 0) {
        return { success: true, message: 'You have no active reminders.' };
    }
    const lines = rows.map(r => {
        if (r.recurrence && r.parent_id !== r.id) return null; // skip child instances of recurring rules
        if (r.recurrence) {
            const day = r.recurrence === 'weekly' && r.weekday !== null
                ? `every ${WEEKDAY_NAMES[r.weekday]}`
                : 'every day';
            return `#${r.id} — 🔁 ${day} at ${r.fire_time_local} — ${truncate(r.message, 80)}`;
        }
        const utc = new Date(r.fire_at_utc);
        return `#${r.id} — ⏰ ${discordTimestamp(utc, 'f')} (${discordTimestamp(utc, 'R')}) — ${truncate(r.message, 80)}`;
    }).filter(Boolean);
    return { success: true, message: `Your active reminders:\n${lines.join('\n')}` };
}

async function doSetReminder(input, message, userId, settings) {
    const text = (input.message || '').trim();
    if (!text) return { success: false, message: 'Reminder message is empty.' };
    if (text.length > 500) return { success: false, message: 'Reminder message is too long (max 500 chars).' };

    if (!settings.timezone || !isValidIANAZone(settings.timezone)) {
        return { success: false, message: 'You need to set your timezone first — run `/timezone <zone>` (e.g., `America/Los_Angeles`).' };
    }

    let utc;
    try {
        utc = localToUtc(input.fire_at_local, settings.timezone);
    } catch (err) {
        return { success: false, message: `Invalid time format: ${err.message}` };
    }

    if (utc.getTime() < Date.now() + 5_000) {
        return { success: false, message: 'That time is in the past. Pick a future time.' };
    }

    const id = createOneShot({
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId,
        fireAtUtc: toSqliteUtc(utc),
        message: text,
    });
    scheduleNewReminder(id);

    return {
        success: true,
        message: `Reminder #${id} set for ${discordTimestamp(utc, 'F')} (${discordTimestamp(utc, 'R')}). I'll ping in this channel.`,
    };
}

async function doSetRecurring(input, message, userId, settings) {
    const text = (input.message || '').trim();
    if (!text) return { success: false, message: 'Reminder message is empty.' };
    if (text.length > 500) return { success: false, message: 'Reminder message is too long (max 500 chars).' };

    if (input.recurrence !== 'daily' && input.recurrence !== 'weekly') {
        return { success: false, message: 'Only "daily" or "weekly" recurrence is supported. For other patterns, set individual one-shot reminders.' };
    }

    if (!settings.timezone || !isValidIANAZone(settings.timezone)) {
        return { success: false, message: 'You need to set your timezone first — run `/timezone <zone>`.' };
    }

    if (!settings.deliveryMode) {
        return { success: false, message: 'Recurring reminders need delivery preferences. Run `/secretary on` first to choose DM or channel delivery.' };
    }

    if (!/^\d{2}:\d{2}$/.test(input.fire_time_local)) {
        return { success: false, message: 'fire_time_local must be in HH:MM format (e.g., "08:00").' };
    }

    let weekday = null;
    if (input.recurrence === 'weekly') {
        if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
            return { success: false, message: 'Weekly recurrence requires a `weekday` value 0–6 (0=Sunday).' };
        }
        weekday = input.weekday;
    }

    // Compute first fire — next occurrence at the local time/weekday from now
    const firstUtc = computeFirstRecurringInstance(settings.timezone, input.recurrence, weekday, input.fire_time_local);

    const id = createRecurring({
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId,
        fireAtUtc: toSqliteUtc(firstUtc),
        message: text,
        recurrence: input.recurrence,
        weekday,
        fireTimeLocal: input.fire_time_local,
    });
    scheduleNewReminder(id);

    const when = input.recurrence === 'weekly'
        ? `every ${WEEKDAY_NAMES[weekday]} at ${input.fire_time_local}`
        : `every day at ${input.fire_time_local}`;
    return {
        success: true,
        message: `Recurring reminder #${id} set: ${when} (${settings.timezone}). First fire: ${discordTimestamp(firstUtc, 'F')} (${discordTimestamp(firstUtc, 'R')}). Delivery: ${settings.deliveryMode === 'dm' ? 'DM' : 'channel'}.`,
    };
}

function doCancel(input, userId) {
    const target = resolveTarget(input, userId);
    if (target.error) return { success: false, message: target.error };

    const cancelledRows = cancelReminder(target.row.id, userId);
    if (cancelledRows === 0) {
        return { success: false, message: `Couldn't cancel reminder #${target.row.id}. It may have already fired.` };
    }
    cancelTimer(target.row.id);

    return {
        success: true,
        message: `Cancelled reminder #${target.row.id}: _"${truncate(target.row.message, 80)}"_${target.row.recurrence ? ` (recurring rule + ${cancelledRows - 1} pending instance${cancelledRows - 1 === 1 ? '' : 's'})` : ''}.`,
    };
}

function doReschedule(input, userId, settings) {
    const target = resolveTarget(input, userId);
    if (target.error) return { success: false, message: target.error };
    const row = target.row;

    if (!settings.timezone || !isValidIANAZone(settings.timezone)) {
        return { success: false, message: 'You need to set your timezone first — run `/timezone <zone>`.' };
    }

    if (row.recurrence) {
        // Recurring: must provide new_fire_time_local (and optionally new_weekday for weekly)
        if (!input.new_fire_time_local || !/^\d{2}:\d{2}$/.test(input.new_fire_time_local)) {
            return { success: false, message: 'For recurring reminders, pass `new_fire_time_local` as HH:MM.' };
        }
        let newWeekday = row.weekday;
        if (row.recurrence === 'weekly' && Number.isInteger(input.new_weekday)) {
            if (input.new_weekday < 0 || input.new_weekday > 6) {
                return { success: false, message: '`new_weekday` must be 0..6.' };
            }
            newWeekday = input.new_weekday;
        }
        const newUtc = computeFirstRecurringInstance(settings.timezone, row.recurrence, newWeekday, input.new_fire_time_local);
        rescheduleRecurring(row.id, userId, {
            newFireAtUtc: toSqliteUtc(newUtc),
            newFireTimeLocal: input.new_fire_time_local,
            newWeekday,
        });
        rescheduleTimer(row.id);
        const when = row.recurrence === 'weekly'
            ? `every ${WEEKDAY_NAMES[newWeekday]} at ${input.new_fire_time_local}`
            : `every day at ${input.new_fire_time_local}`;
        return {
            success: true,
            message: `Rescheduled #${row.id} → ${when} (${settings.timezone}). Next fire: ${discordTimestamp(newUtc, 'F')} (${discordTimestamp(newUtc, 'R')}).`,
        };
    } else {
        // One-shot: must provide new_fire_at_local
        if (!input.new_fire_at_local) {
            return { success: false, message: 'For one-shot reminders, pass `new_fire_at_local` as "YYYY-MM-DD HH:MM".' };
        }
        let newUtc;
        try {
            newUtc = localToUtc(input.new_fire_at_local, settings.timezone);
        } catch (err) {
            return { success: false, message: `Invalid time: ${err.message}` };
        }
        if (newUtc.getTime() < Date.now() + 5_000) {
            return { success: false, message: 'That time is in the past.' };
        }
        rescheduleOneShot(row.id, userId, toSqliteUtc(newUtc));
        rescheduleTimer(row.id);
        return {
            success: true,
            message: `Rescheduled #${row.id} → ${discordTimestamp(newUtc, 'F')} (${discordTimestamp(newUtc, 'R')}).`,
        };
    }
}

function resolveTarget(input, userId) {
    if (input.id) {
        const row = getReminderById(input.id);
        if (!row || row.user_id !== userId) return { error: `No reminder #${input.id} found for you.` };
        if (row.fired_at) return { error: `Reminder #${input.id} already fired.` };
        if (row.cancelled_at) return { error: `Reminder #${input.id} was already cancelled.` };
        return { row };
    }
    if (input.query) {
        const matches = findActiveByQuery(userId, input.query, 5);
        if (matches.length === 0) return { error: `No active reminder matches "${input.query}".` };
        if (matches.length > 1) {
            const list = matches.map(r => `#${r.id} — ${truncate(r.message, 60)}`).join('\n');
            return { error: `Multiple matches for "${input.query}":\n${list}\n\nWhich one? Tell me the ID.` };
        }
        return { row: matches[0] };
    }
    return { error: 'Provide either an `id` or a `query` to identify the reminder.' };
}

// ── Helpers ──

/**
 * Compute the first UTC fire time for a recurring rule, given:
 *   - user's IANA zone
 *   - recurrence: 'daily' | 'weekly'
 *   - weekday (only for 'weekly'): 0..6
 *   - fireTimeLocal: 'HH:MM'
 *
 * For daily: today at HH:MM (or tomorrow if HH:MM has already passed today).
 * For weekly: the NEXT instance of the given weekday at HH:MM (today if today
 * matches and the time hasn't passed; otherwise the next occurrence).
 */
function computeFirstRecurringInstance(zone, recurrence, weekday, fireTimeLocal) {
    const [hh, mm] = fireTimeLocal.split(':').map(Number);
    const now = new Date();

    // Get "today" in the target zone as Y-M-D
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const todayY = parseInt(get('year'), 10);
    const todayM = parseInt(get('month'), 10);
    const todayD = parseInt(get('day'), 10);
    const todayWeekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'));
    const todayHour = parseInt(get('hour'), 10);
    const todayMinute = parseInt(get('minute'), 10);

    if (recurrence === 'daily') {
        // Today at HH:MM; if already past, tomorrow at HH:MM
        const todayLocal = `${pad(todayY, 4)}-${pad(todayM)}-${pad(todayD)} ${pad(hh)}:${pad(mm)}`;
        const todayUtc = localToUtc(todayLocal, zone);
        if (todayUtc.getTime() > now.getTime() + 60_000) return todayUtc;
        // Tomorrow
        const tomorrow = new Date(Date.UTC(todayY, todayM - 1, todayD + 1));
        return localToUtc(`${pad(tomorrow.getUTCFullYear(), 4)}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(tomorrow.getUTCDate())} ${pad(hh)}:${pad(mm)}`, zone);
    }

    // weekly
    let daysUntil = (weekday - todayWeekday + 7) % 7;
    if (daysUntil === 0) {
        // Today matches — but only use today if the time hasn't passed
        const todayLocal = `${pad(todayY, 4)}-${pad(todayM)}-${pad(todayD)} ${pad(hh)}:${pad(mm)}`;
        const todayUtc = localToUtc(todayLocal, zone);
        if (todayUtc.getTime() > now.getTime() + 60_000) return todayUtc;
        daysUntil = 7; // next week
    }
    const target = new Date(Date.UTC(todayY, todayM - 1, todayD + daysUntil));
    return localToUtc(
        `${pad(target.getUTCFullYear(), 4)}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())} ${pad(hh)}:${pad(mm)}`,
        zone,
    );
}

function pad(n, len = 2) { return String(n).padStart(len, '0'); }
