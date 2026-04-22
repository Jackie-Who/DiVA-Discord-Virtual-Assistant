import { ActivityType } from 'discord.js';
import logger from '../utils/logger.js';
import { cleanupOldMessages } from '../db/history.js';

export default function ready(client) {
    client.once('ready', () => {
        logger.info('Bot is online', {
            tag: client.user.tag,
            guilds: client.guilds.cache.size,
        });

        // Bio-style status: "Discord Virtual Assistant | @mention me"
        client.user.setActivity('Discord Virtual Assistant | @mention me', { type: ActivityType.Custom });

        // Run cleanup on startup and every 12 hours
        cleanupOldMessages();
        setInterval(() => cleanupOldMessages(), 12 * 60 * 60 * 1000);
    });
}
