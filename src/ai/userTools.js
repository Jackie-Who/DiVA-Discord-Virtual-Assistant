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
import { localToUtc, formatLocal, toSqliteUtc, parseSqliteUtc, isValidIANAZone, discordTimestamp } from '../utils/timezone.js';
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
    updateReminderMessage,
} from '../db/reminders.js';
import { scheduleNewReminder, cancelTimer, rescheduleTimer } from '../utils/reminderScheduler.js';
import { setTimezone } from '../db/userSettings.js';
import anthropic from './client.js';
import { recordUsage } from '../db/tokenBudget.js';

const SUGGESTION_MODEL = 'claude-haiku-4-5-20251001';

const SHORT_REMINDER_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h — short reminders auto-execute, no confirmation

// ── Tool schemas (Anthropic tool_use format) ──

export const USER_TOOL_DEFINITIONS = [
    {
        name: 'set_timezone',
        description: 'Set the current user\'s timezone. Use this when the user describes their timezone in natural language (e.g., "set my timezone to vancouver time", "I\'m in EST", "Tokyo time"). YOU are responsible for resolving the user\'s phrase to a valid IANA timezone identifier (e.g., "America/Vancouver", "America/New_York", "Asia/Tokyo"). Use the closest major-city IANA zone. NEVER pass the user\'s raw phrase — always pass a canonical IANA name.',
        input_schema: {
            type: 'object',
            properties: {
                iana_zone: {
                    type: 'string',
                    description: 'A valid IANA timezone identifier you derived from the user\'s description. Examples: "America/Los_Angeles", "America/Vancouver", "America/New_York", "America/Chicago", "America/Denver", "America/Toronto", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney". For ambiguous phrases like "PST" or "EST", prefer the matching America/* zone (e.g., "PST" → "America/Los_Angeles" since it handles DST too).',
                },
            },
            required: ['iana_zone'],
        },
    },
    {
        name: 'set_reminder',
        description: 'Schedule a one-shot reminder for the current user. Pass EITHER seconds_from_now OR fire_at_local — NEVER both. Choose based on duration: under 1 hour → seconds_from_now; 1 hour or longer → fire_at_local. The 1-hour boundary is HARD — do not put 7200 (2 hours) in seconds_from_now, that will be REJECTED. For "in 2 hours", "in 3 hours", "tomorrow", etc., always use fire_at_local.',
        input_schema: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The reminder text (max 500 chars).',
                },
                seconds_from_now: {
                    type: 'integer',
                    description: 'Exact seconds from now until the reminder fires. ONLY use for reminders STRICTLY UNDER 1 HOUR (3600 seconds). Examples: "in 30 seconds" → 30, "in 1 minute" → 60, "in 5 minutes" → 300, "in half an hour" → 1800, "in 45 minutes" → 2700, "in 59 minutes" → 3540. For ANYTHING 1 hour or longer ("in 1 hour", "in 2 hours", "in 3 hours", "tomorrow", etc.), DO NOT pass this — use fire_at_local instead. Min 5, max 3600.',
                    minimum: 5,
                    maximum: 3600,
                },
                fire_at_local: {
                    type: 'string',
                    description: 'When to fire, in the USER\'S local timezone, formatted "YYYY-MM-DD HH:MM" (24-hour). REQUIRED for ANY reminder 1 hour or more from now: "in 1 hour", "in 2 hours", "in 3 hours", "tomorrow at 9am", "next Monday morning", "in 3 days", etc. Compute by adding the duration to the user\'s current local time given in the system prompt. The user MUST have set their timezone first.',
                },
            },
            required: ['message'],
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
// Tools that bypass the confirmation card and execute immediately. set_timezone
// is harmless (just updates the user's preference); short one-shot reminders
// (less than 24h away) skip confirmation per UX direction.
const USER_AUTO_EXECUTE_TOOLS = new Set(['set_timezone']);

export function isUserTool(name) { return USER_TOOLS.has(name); }
export function isReadOnlyUserTool(name) { return USER_READ_ONLY_TOOLS.has(name); }

/**
 * Returns true when this user-tool call should bypass the confirmation card
 * and execute immediately. Currently:
 *   - set_timezone: always
 *   - set_reminder: when fire_at_local resolves to less than 24h away
 *
 * Long reminders (>=24h), recurring reminders, cancel, and reschedule still
 * require confirmation.
 */
export function shouldSkipConfirmation(toolName, input, userId) {
    if (USER_AUTO_EXECUTE_TOOLS.has(toolName)) return true;
    if (toolName !== 'set_reminder') return false;

    // Sub-1h reminders specified via seconds_from_now always skip confirmation
    // (the seconds_from_now schema caps at 3600 = 1 hour anyway).
    if (Number.isInteger(input.seconds_from_now)) {
        return input.seconds_from_now > 0 && input.seconds_from_now <= 3600;
    }

    // For fire_at_local input, check whether the resolved time is < 24h away
    if (!input.fire_at_local) return false;
    const settings = getUserSettings(userId);
    if (!settings.timezone) return false;
    try {
        const utc = localToUtc(input.fire_at_local, settings.timezone);
        const ms = utc.getTime() - Date.now();
        return ms > 0 && ms < SHORT_REMINDER_THRESHOLD_MS;
    } catch {
        return false; // can't compute → fall through to normal confirmation flow (which will surface the parse error)
    }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Confirmation card formatter ──

export function formatUserToolForConfirmation(toolName, input, userId) {
    const tz = getUserSettings(userId).timezone || 'UTC';

    switch (toolName) {
        case 'set_timezone': {
            return `🕒 **Set timezone:** \`${input.iana_zone}\``;
        }
        case 'set_reminder': {
            // seconds_from_now path doesn't need confirmation (auto-executes), but
            // we still format it correctly here in case the policy changes.
            if (Number.isInteger(input.seconds_from_now)) {
                const utc = new Date(Date.now() + input.seconds_from_now * 1000);
                return `⏰ **Reminder:** _"${truncate(input.message, 80)}"_\n→ ${discordTimestamp(utc, 'F')} (${discordTimestamp(utc, 'R')})`;
            }
            try {
                const utc = localToUtc(input.fire_at_local, tz);
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
                // Resolve position → DB row to preview the actual reminder's content
                const active = getActiveRemindersForUser(userId);
                const r = active[input.id - 1];
                if (r) {
                    const when = r.recurrence
                        ? ` (${r.recurrence} at ${r.fire_time_local})`
                        : ` (${discordTimestamp(parseSqliteUtc(r.fire_at_utc), 'R')})`;
                    return `🗑️ **Cancel reminder #${input.id}:** _"${truncate(r.message, 80)}"_${when}`;
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
            case 'set_timezone':                return doSetTimezone(input, userId);
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

function doSetTimezone(input, userId) {
    const zone = (input.iana_zone || '').trim();
    if (!zone) {
        return { success: false, message: 'Timezone cannot be empty.' };
    }
    if (!isValidIANAZone(zone)) {
        return {
            success: false,
            message: `"${zone}" is not a valid IANA timezone. Try a city/region name like "America/Los_Angeles", "America/Vancouver", "Europe/London", or "Asia/Tokyo".`,
        };
    }
    setTimezone(userId, zone);
    const now = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
    return {
        success: true,
        message: `Timezone set to \`${zone}\`. It's currently **${now}** in your timezone.`,
    };
}

function doListMine(userId, _settings) {
    const rows = getActiveRemindersForUser(userId);
    if (rows.length === 0) {
        return { success: true, message: 'You have no active reminders.' };
    }
    // Position-based IDs: re-numbered 1..N based on the user's current active list.
    // The DB AUTOINCREMENT row IDs are hidden — when the user says "cancel #2",
    // we resolve position 2 against this same list ordering.
    const lines = rows.map((r, i) => {
        const position = i + 1;
        if (r.recurrence) {
            const day = r.recurrence === 'weekly' && r.weekday !== null
                ? `every ${WEEKDAY_NAMES[r.weekday]}`
                : 'every day';
            return `#${position} — 🔁 ${day} at ${r.fire_time_local} — ${truncate(r.message, 80)}`;
        }
        const utc = parseSqliteUtc(r.fire_at_utc);
        return `#${position} — ⏰ ${discordTimestamp(utc, 'f')} (${discordTimestamp(utc, 'R')}) — ${truncate(r.message, 80)}`;
    });
    return { success: true, message: `Your active reminders:\n${lines.join('\n')}` };
}

async function doSetReminder(input, message, userId, settings) {
    const text = (input.message || '').trim();
    if (!text) return { success: false, message: 'Reminder message is empty.' };
    if (text.length > 500) return { success: false, message: 'Reminder message is too long (max 500 chars).' };

    let utc;
    if (Number.isInteger(input.seconds_from_now)) {
        // Sub-1h path: precise to the second using actual current time.
        // No timezone needed — relative offset is timezone-independent.
        if (input.seconds_from_now < 5 || input.seconds_from_now > 3600) {
            return { success: false, message: 'seconds_from_now must be between 5 and 3600 (1 hour). For longer reminders, use fire_at_local.' };
        }
        utc = new Date(Date.now() + input.seconds_from_now * 1000);
    } else if (input.fire_at_local) {
        // Long-reminder path: needs the user's timezone to anchor the local time.
        if (!settings.timezone || !isValidIANAZone(settings.timezone)) {
            return { success: false, message: 'You need to set your timezone first — run `/timezone <zone>` (e.g., `America/Los_Angeles`).' };
        }
        try {
            utc = localToUtc(input.fire_at_local, settings.timezone);
        } catch (err) {
            return { success: false, message: `Invalid time format: ${err.message}` };
        }
        if (utc.getTime() < Date.now() + 5_000) {
            return { success: false, message: 'That time is in the past. Pick a future time.' };
        }
    } else {
        return { success: false, message: 'Either seconds_from_now (for reminders under 1 hour) or fire_at_local (for longer ones) must be provided.' };
    }

    const dbId = createOneShot({
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId,
        fireAtUtc: toSqliteUtc(utc),
        message: text,
    });
    scheduleNewReminder(dbId);

    // Resolve display position so the success message uses the same numbering
    // the user would see in /reminder list.
    const position = positionFor(userId, dbId);

    // Fire-and-forget AI title optimization. If Haiku suggests something
    // different, the chat layer attaches a "✨ Use suggested" button to the reply.
    const suggested = await generateAiSuggestion(text, message.guild.id, userId);

    return {
        success: true,
        message: `Reminder #${position} set for ${discordTimestamp(utc, 'F')} (${discordTimestamp(utc, 'R')}):\n> ${text}\nI'll ping you in this channel.`,
        aiSuggestion: suggested ? { reminderId: dbId, originalTitle: text, suggestedTitle: suggested } : undefined,
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

    const dbId = createRecurring({
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId,
        fireAtUtc: toSqliteUtc(firstUtc),
        message: text,
        recurrence: input.recurrence,
        weekday,
        fireTimeLocal: input.fire_time_local,
    });
    scheduleNewReminder(dbId);

    const position = positionFor(userId, dbId);
    const when = input.recurrence === 'weekly'
        ? `every ${WEEKDAY_NAMES[weekday]} at ${input.fire_time_local}`
        : `every day at ${input.fire_time_local}`;

    const suggested = await generateAiSuggestion(text, message.guild.id, userId);

    return {
        success: true,
        message: `Recurring reminder #${position} set: ${when} (${settings.timezone}):\n> ${text}\nFirst fire: ${discordTimestamp(firstUtc, 'F')} (${discordTimestamp(firstUtc, 'R')}). Delivery: ${settings.deliveryMode === 'dm' ? 'DM' : 'channel'}.`,
        aiSuggestion: suggested ? { reminderId: dbId, originalTitle: text, suggestedTitle: suggested } : undefined,
    };
}

function doCancel(input, userId) {
    // Capture the position BEFORE cancellation (after cancel, the list shrinks)
    const positionBefore = input.id ? input.id : null;
    const target = resolveTarget(input, userId);
    if (target.error) return { success: false, message: target.error };

    const cancelledRows = cancelReminder(target.row.id, userId);
    if (cancelledRows === 0) {
        return { success: false, message: `Couldn't cancel that reminder. It may have already fired.` };
    }
    cancelTimer(target.row.id);

    const ref = positionBefore ? `#${positionBefore}` : `_"${truncate(target.row.message, 60)}"_`;
    return {
        success: true,
        message: `Cancelled reminder ${ref}: _"${truncate(target.row.message, 80)}"_${target.row.recurrence ? ` (recurring rule + ${cancelledRows - 1} pending instance${cancelledRows - 1 === 1 ? '' : 's'})` : ''}.`,
    };
}

function doReschedule(input, userId, settings) {
    const positionBefore = input.id ? input.id : null;
    const target = resolveTarget(input, userId);
    if (target.error) return { success: false, message: target.error };
    const row = target.row;
    const refLabel = positionBefore ? `#${positionBefore}` : `_"${truncate(row.message, 60)}"_`;

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
            message: `Rescheduled ${refLabel} → ${when} (${settings.timezone}). Next fire: ${discordTimestamp(newUtc, 'F')} (${discordTimestamp(newUtc, 'R')}).`,
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
            message: `Rescheduled ${refLabel} → ${discordTimestamp(newUtc, 'F')} (${discordTimestamp(newUtc, 'R')}).`,
        };
    }
}

function resolveTarget(input, userId) {
    if (input.id) {
        // input.id is a 1-indexed POSITION in the user's active list (NOT a DB id).
        // Re-fetch the active list and pick by index so display IDs always match
        // what the user just saw in /reminder list or list_my_reminders.
        const active = getActiveRemindersForUser(userId);
        const position = input.id;
        if (!Number.isInteger(position) || position < 1 || position > active.length) {
            if (active.length === 0) {
                return { error: `You have no active reminders to reference. List with /reminder list.` };
            }
            return { error: `No reminder at position #${position}. You have ${active.length} active reminder${active.length === 1 ? '' : 's'} (numbered 1–${active.length}).` };
        }
        return { row: active[position - 1] };
    }
    if (input.query) {
        const matches = findActiveByQuery(userId, input.query, 5);
        if (matches.length === 0) return { error: `No active reminder matches "${input.query}".` };
        if (matches.length > 1) {
            // Show position-based IDs so the user can disambiguate without confusion
            const active = getActiveRemindersForUser(userId);
            const list = matches.map(m => {
                const pos = active.findIndex(r => r.id === m.id) + 1;
                return `#${pos} — ${truncate(m.message, 60)}`;
            }).join('\n');
            return { error: `Multiple matches for "${input.query}":\n${list}\n\nWhich one? Tell me the position number.` };
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

/**
 * Find the 1-indexed display position of a reminder (by its DB id) in the
 * user's currently-active list. Used to show the user a stable position
 * number after creating/rescheduling.
 */
function positionFor(userId, dbId) {
    const active = getActiveRemindersForUser(userId);
    const idx = active.findIndex(r => r.id === dbId);
    return idx >= 0 ? idx + 1 : '?';
}

/**
 * Ask Haiku to optimize a reminder title (e.g. "groceries" → "Grocery Shopping").
 * Returns null if the suggestion is identical/whitespace-equivalent to the
 * original (no point showing a swap button), or if the call fails.
 *
 * Cost is recorded against the originating guild via recordUsage().
 */
async function generateAiSuggestion(originalText, guildId, userId) {
    const trimmed = originalText.trim();
    if (!trimmed || trimmed.length > 200) return null;

    try {
        const response = await anthropic.messages.create({
            model: SUGGESTION_MODEL,
            max_tokens: 30,
            messages: [{
                role: 'user',
                content: `You are optimizing a Discord reminder title. Convert the user's casual phrase into a clean, concise title (2-5 words, properly capitalized). Strip out time/date words ("tomorrow", "in 3 hours", "every morning") because the firing time is tracked separately. Keep the verb if there is one.

Examples:
"groceries" → Grocery Shopping
"call mom" → Call Mom
"do laundry tomorrow" → Do Laundry
"test the bot in 3 hours" → Test the Bot
"stretch every morning" → Morning Stretch
"pick up dry cleaning" → Pick Up Dry Cleaning
"meeting with sara" → Meeting with Sara

If the original is already 2-5 polished words with proper capitalization, return it unchanged.

Return ONLY the optimized title. No quotes, no explanation, no prefix.

Original: ${trimmed}`,
            }],
        });

        const raw = response.content[0]?.text || '';
        const suggested = raw.trim()
            .replace(/^["'`]+|["'`]+$/g, '')
            .replace(/^(Optimized:|Title:|Suggestion:)\s*/i, '')
            .trim();

        if (response.usage) {
            recordUsage(guildId, userId, response.usage.input_tokens, response.usage.output_tokens, SUGGESTION_MODEL);
        }

        if (!suggested) return null;
        if (suggested.length > 100) return null; // sanity cap
        if (suggested.toLowerCase() === trimmed.toLowerCase()) return null;
        return suggested;
    } catch (err) {
        logger.warn('AI suggestion generation failed', { error: err.message });
        return null;
    }
}

/**
 * Apply a previously-suggested title to a reminder. Called from the button
 * handler in messageCreate.js. Validates ownership + still-active state.
 */
export async function applyAiSuggestion(reminderId, userId, newTitle) {
    const trimmed = (newTitle || '').trim();
    if (!trimmed || trimmed.length > 500) {
        return { success: false, message: 'Suggested title is invalid.' };
    }
    const ok = updateReminderMessage(reminderId, userId, trimmed);
    if (!ok) {
        return { success: false, message: 'Could not update the reminder (already fired, cancelled, or not yours).' };
    }
    return { success: true, message: trimmed };
}
