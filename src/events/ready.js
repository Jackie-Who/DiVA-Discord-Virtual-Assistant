import { ActivityType } from 'discord.js';
import logger from '../utils/logger.js';
import { cleanupOldMessages } from '../db/history.js';

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
    });
}
