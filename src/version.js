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

export const BOT_VERSION = '1.2.0';

/**
 * Per-version changelog. Entries shown in the update notice. Keep them brief
 * and user-facing (this goes to every server's notices channel).
 */
export const CHANGELOG = {
    '1.2.0': [
        'Per-server credit billing replaces the global monthly budget',
        'New `/credits` command shows your server\'s balance and recent transactions',
        'New `/timezone` command for per-user timezone settings',
        'New `/reminder` and `/secretary` commands — set reminders in plain English',
        'New `/channel` command for routing errors, metrics, and notices to your own channels',
        'New `/notices on/off` to control update announcements',
        'Removed `/create-channel`, `/delete-channel`, `/ban`, `/kick`, `/purge` — Discord\'s built-in UI handles those better',
    ],
};
