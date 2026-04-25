import { ActivityType } from 'discord.js';
import logger from '../utils/logger.js';
import { cleanupOldMessages } from '../db/history.js';
import { runUpdateNotifier } from '../utils/updateNotifier.js';

export default function ready(client) {
    client.once('ready', () => {
        logger.info('Bot is online', {
            tag: client.user.tag,
            guilds: client.guilds.cache.size,
        });

        client.user.setActivity('for @mentions', { type: ActivityType.Watching });

        // Run cleanup on startup and every 12 hours
        cleanupOldMessages();
        setInterval(() => cleanupOldMessages(), 12 * 60 * 60 * 1000);

        // Post update notice if BOT_VERSION has changed since last announcement.
        // No-op in dev. Fire-and-forget so a slow guild can't delay startup tasks.
        runUpdateNotifier(client).catch(err =>
            logger.error('Update notifier failed', { error: err.message, stack: err.stack })
        );
    });
}
