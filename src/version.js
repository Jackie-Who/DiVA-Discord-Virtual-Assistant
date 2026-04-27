/**
 * Bot version + changelog. Increment BOT_VERSION when shipping a release that
 * should announce itself to opted-in servers (every server has notices_enabled=1
 * by default — opt-OUT model).
 *
 * The update notifier compares this to bot_metadata.last_announced_version on
 * startup and posts to each server's notices channel when it changes.
 *
 * Versions are SemVer-compared (major.minor.patch).
 */

export const BOT_VERSION = '1.2.1';

/**
 * Per-version changelog. Entries shown in the update notice. Keep them brief
 * and user-facing (this goes to every server's notices channel).
 */
export const CHANGELOG = {
    '1.2.1': [
        '🔔 **1-hour heads-up before reminders** with [Snooze 30m] and [Dismiss] buttons. Recurring reminders always get one; one-shots only if set 3+ hours out.',
        '📅 **Daily digest revamp** — reminders now grouped into `Today`, then individual day sub-headers (e.g. _Tuesday, Apr 28_) for the next 2 days. Empty digests no longer ping.',
    ],
    '1.2.0': [
        'Per-server credit billing replaces the global monthly budget',
        'New `/credits` to view your server\'s balance and recent transactions',
        'New `/timezone` for per-user timezone — or just say "set my timezone to vancouver"',
        '**Natural-language reminders!** "Remind me about groceries in 3 hours" — and a ✨ AI-suggested title button',
        'Daily digest with `/secretary on` — get your day\'s reminders pinged at a time you choose',
        'New `/channel set` to route errors, metrics, and update notices to your own channels',
        'New `/notices on/off` to opt out of these announcements',
        'Removed `/create-channel`, `/delete-channel`, `/ban`, `/kick`, `/purge` — Discord\'s native UI is faster',
    ],
};
