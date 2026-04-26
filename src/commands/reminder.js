/**
 * /reminder list   — list this user's active reminders (numbered 1..N)
 * /reminder delete <id> — delete a reminder by its position (#1..#N from /reminder list)
 *
 * Note: reminder *creation* happens via natural language (the bot's tool system)
 * because parsing "tomorrow at 9am" or "every Monday morning" is what Claude is
 * for. These slash commands are just the visual management surface.
 *
 * The numeric `id` shown to users is a 1-indexed POSITION within their current
 * active reminder list — NOT the underlying DB row ID. This way, if you have
 * one reminder left after deleting two others, it shows as #1 (not #4 or #7).
 */

import { getActiveRemindersForUser, cancelReminder } from '../db/reminders.js';
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

        // Number rows in display order, then split into one-shot vs recurring sections
        const numbered = rows.map((r, i) => ({ row: r, position: i + 1 }));
        const oneShots = numbered.filter(({ row }) => !row.recurrence);
        const recurring = numbered.filter(({ row }) => row.recurrence);

        let body = '';
        if (oneShots.length > 0) {
            body += '**One-shot:**\n';
            body += oneShots.map(({ row, position }) => formatRow(row, position)).join('\n') + '\n';
        }
        if (recurring.length > 0) {
            if (body) body += '\n';
            body += '**Recurring:**\n';
            body += recurring.map(({ row, position }) => formatRow(row, position)).join('\n');
        }
        body += '\n\n_Cancel one with `/reminder delete id:<number>` (use the # shown above)._';

        return interaction.reply({
            embeds: [{
                title: '⏰ Your Reminders',
                description: body.slice(0, 4000),
                color: 0x5865F2,
            }],
            ephemeral: true,
        });
    }

    if (sub === 'delete') {
        const position = interaction.options.getInteger('id', true);
        const active = getActiveRemindersForUser(userId);
        if (active.length === 0) {
            return interaction.reply({ content: 'You have no active reminders.', ephemeral: true });
        }
        if (position < 1 || position > active.length) {
            return interaction.reply({
                content: `No reminder at position #${position}. You have ${active.length} active reminder${active.length === 1 ? '' : 's'} (numbered 1–${active.length}).`,
                ephemeral: true,
            });
        }

        const row = active[position - 1];
        const cancelled = cancelReminder(row.id, userId);
        cancelTimer(row.id);

        const label = row.recurrence
            ? `recurring rule (also cancelled ${cancelled - 1} pending instance${cancelled - 1 === 1 ? '' : 's'})`
            : 'reminder';
        return interaction.reply({
            content: `🗑️ Cancelled ${label} #${position} — _"${row.message.slice(0, 100)}"_.`,
            ephemeral: true,
        });
    }
}

function formatRow(r, position) {
    if (r.recurrence) {
        const day = r.recurrence === 'weekly' && r.weekday !== null
            ? `every ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday]}`
            : 'every day';
        return `\`#${position}\` 🔁 ${day} at ${r.fire_time_local} — ${r.message.slice(0, 100)}`;
    }
    const fireAt = parseSqliteUtc(r.fire_at_utc);
    return `\`#${position}\` ⏰ ${discordTimestamp(fireAt, 'f')} (${discordTimestamp(fireAt, 'R')}) — ${r.message.slice(0, 100)}`;
}
