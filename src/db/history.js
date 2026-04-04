import { getDb } from './init.js';
import config from '../config.js';
import logger from '../utils/logger.js';

export function saveMessage(guildId, channelId, userId, userName, role, content) {
    const db = getDb();
    db.prepare(`
        INSERT INTO conversations (guild_id, channel_id, user_id, user_name, role, content)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, channelId, userId, userName, role, content);
}

export function getRecentHistory(guildId, channelId, userId, limit) {
    limit = limit ?? config.maxHistoryMessages;
    const db = getDb();

    // Only pull messages from the last 30 minutes — older = stale conversation
    const rows = db.prepare(`
        SELECT role, content FROM conversations
        WHERE guild_id = ? AND channel_id = ? AND user_id = ?
            AND created_at > datetime('now', '-30 minutes')
        ORDER BY created_at DESC
        LIMIT ?
    `).all(guildId, channelId, userId, limit);

    return rows.reverse();
}

export function getRecentBotInteractions(guildId, limit = 15) {
    const db = getDb();

    // Get recent assistant responses paired with the user message before them
    const rows = db.prepare(`
        SELECT c1.user_name, c1.content AS user_message, c2.content AS bot_response
        FROM conversations c1
        INNER JOIN conversations c2 ON c2.guild_id = c1.guild_id
            AND c2.channel_id = c1.channel_id
            AND c2.user_id = c1.user_id
            AND c2.role = 'assistant'
            AND c2.id = (
                SELECT MIN(id) FROM conversations
                WHERE guild_id = c1.guild_id
                    AND channel_id = c1.channel_id
                    AND user_id = c1.user_id
                    AND role = 'assistant'
                    AND id > c1.id
            )
        WHERE c1.guild_id = ? AND c1.role = 'user'
        ORDER BY c1.created_at DESC
        LIMIT ?
    `).all(guildId, limit);

    return rows.reverse().map(row => ({
        userName: row.user_name,
        userMessage: row.user_message.slice(0, 150),
        botResponse: row.bot_response.slice(0, 150),
    }));
}

/**
 * Get recent conversation pairs from a channel (any user), truncated for context injection.
 * Returns the last N user→assistant exchanges.
 */
export function getChannelMemory(guildId, channelId, limit = 5) {
    const db = getDb();

    const rows = db.prepare(`
        SELECT c1.user_name, c1.content AS user_message, c2.content AS bot_response
        FROM conversations c1
        INNER JOIN conversations c2 ON c2.guild_id = c1.guild_id
            AND c2.channel_id = c1.channel_id
            AND c2.user_id = c1.user_id
            AND c2.role = 'assistant'
            AND c2.id = (
                SELECT MIN(id) FROM conversations
                WHERE guild_id = c1.guild_id
                    AND channel_id = c1.channel_id
                    AND user_id = c1.user_id
                    AND role = 'assistant'
                    AND id > c1.id
            )
        WHERE c1.guild_id = ? AND c1.channel_id = ? AND c1.role = 'user'
        ORDER BY c1.created_at DESC
        LIMIT ?
    `).all(guildId, channelId, limit);

    return rows.reverse().map(row => ({
        userName: row.user_name,
        userMessage: row.user_message.slice(0, 150),
        botResponse: row.bot_response.slice(0, 150),
    }));
}

export function cleanupOldMessages(days) {
    days = days ?? config.historyRetentionDays;
    const db = getDb();

    const result = db.prepare(`
        DELETE FROM conversations
        WHERE created_at < datetime('now', ?)
    `).run(`-${days} days`);

    if (result.changes > 0) {
        logger.info('Cleaned up old messages', { deleted: result.changes, olderThanDays: days });
    }
}
