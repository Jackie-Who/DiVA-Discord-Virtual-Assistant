/**
 * /timezone <zone>
 *
 * Saves the user's IANA timezone (e.g., "America/Los_Angeles") so reminders and
 * the secretary digest fire at the time the user actually wrote down.
 *
 * Validation: we trust whatever IANA Node accepts via Intl.DateTimeFormat. This
 * matches what the scheduler will use later.
 */

import { setTimezone, getUserSettings } from '../db/userSettings.js';

function isValidIANAZone(zone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export default async function timezone(interaction) {
    const zone = interaction.options.getString('zone', true).trim();

    if (!isValidIANAZone(zone)) {
        return interaction.reply({
            content: [
                `❌ \`${zone}\` doesn't look like a valid timezone.`,
                '',
                'Use an IANA name like:',
                '• `America/Los_Angeles`',
                '• `America/New_York`',
                '• `Europe/London`',
                '• `Asia/Tokyo`',
                '',
                'Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones',
            ].join('\n'),
            ephemeral: true,
        });
    }

    const userId = interaction.user.id;
    const previous = getUserSettings(userId).timezone;
    setTimezone(userId, zone);

    // Show what time it is in the user's zone right now so they can sanity-check
    const now = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(new Date());

    const verb = previous ? `Updated from \`${previous}\`` : 'Set';
    await interaction.reply({
        content: `🕒 ${verb} → \`${zone}\`. It's currently **${now}** in your timezone.`,
        ephemeral: true,
    });
}
