/**
 * /reminder list   — list this user's active reminders
 * /reminder delete <id> — delete a reminder by ID
 *
 * Note: reminder *creation* happens via natural language (the bot's tool system)
 * because parsing "tomorrow at 9am" or "every Monday morning" is what Claude is
 * for. These slash commands are just the visual management surface.
 */

import { getActiveRemindersForUser, cancelReminder, getReminderById } from '../db/reminders.js';
import { getUserSettings } from '../db/userSettings.js';
import { cancelTimer } from '../utils/reminderScheduler.js';
import { discordTimestamp, parseSqliteUtc } from '../utils/timezone.js';

export default async function reminder(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'list') {
        const rows = getActiveRemindersForUser(userId);
        if (rows.length === 0) {
            return interaction.reply({
                content: 'You don\'t have any active reminders. Set one by @mentioning me — try _"remind me to take out the trash tomorrow at 9am"_.',
                ephemeral: true,
            });
        }

        const settings = getUserSettings(userId);
        const tz = settings.timezone || 'UTC';

        const oneShots = rows.filter(r => !r.recurrence);
        const recurring = rows.filter(r => r.recurrence && r.parent_id === r.id);

        let body = '';
        if (oneShots.length > 0) {
            body += '**One-shot:**\n';
            body += oneShots.map(r => formatRow(r, tz)).filter(Boolean).join('\n') + '\n';
        }
        if (recurring.length > 0) {
            if (body) body += '\n';
            body += '**Recurring:**\n';
            body += recurring.map(r => formatRow(r, tz)).filter(Boolean).join('\n');
        }
        body += '\n\n_Cancel one with `/reminder delete id:<number>`._';

        return interaction.reply({
            embeds: [{
                title: '⏰ Your Reminders',
                description: body.slice(0, 4000),
                color: 0x5865F2,
                footer: { text: `Times shown in ${tz}` },
            }],
            ephemeral: true,
        });
    }

    if (sub === 'delete') {
        const id = interaction.options.getInteger('id', true);
        const row = getReminderById(id);
        if (!row || row.user_id !== userId) {
            return interaction.reply({ content: `No reminder #${id} found for you.`, ephemeral: true });
        }
        if (row.fired_at) {
            return interaction.reply({ content: `Reminder #${id} already fired.`, ephemeral: true });
        }
        if (row.cancelled_at) {
            return interaction.reply({ content: `Reminder #${id} was already cancelled.`, ephemeral: true });
        }

        const cancelled = cancelReminder(id, userId);
        // Clear in-memory timer (works for both rule and child rows)
        cancelTimer(id);
        if (row.recurrence) {
            // For recurring, the cancelReminder above also nuked any pending child instances.
            // Their timers might still be alive — sweep them.
            // (This is rare and the cost is small, so we don't bother enumerating them here;
            // the next hourly sweep will skip them since cancelled_at is set.)
        }

        const label = row.recurrence ? `recurring rule (cancelled ${cancelled} pending instance${cancelled === 1 ? '' : 's'})` : 'reminder';
        return interaction.reply({
            content: `🗑️ Cancelled ${label} _"${row.message.slice(0, 100)}"_.`,
            ephemeral: true,
        });
    }
}

function formatRow(r, _tz) {
    if (r.recurrence && r.parent_id !== r.id) return null; // skip child instances of recurring rules
    if (r.recurrence) {
        const day = r.recurrence === 'weekly' && r.weekday !== null
            ? `every ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday]}`
            : 'every day';
        return `\`#${r.id}\` 🔁 ${day} at ${r.fire_time_local} — ${r.message.slice(0, 100)}`;
    }
    const fireAt = parseSqliteUtc(r.fire_at_utc);
    return `\`#${r.id}\` ⏰ ${discordTimestamp(fireAt, 'f')} (${discordTimestamp(fireAt, 'R')}) — ${r.message.slice(0, 100)}`;
}
