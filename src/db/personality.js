import { getDb } from './init.js';
import config from '../config.js';

export function getPersonality(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT personality_prompt FROM guild_personality WHERE guild_id = ?').get(guildId);
    return row ? row.personality_prompt : '';
}

export function updatePersonality(guildId, newPrompt) {
    const db = getDb();
    db.prepare(`
        INSERT INTO guild_personality (guild_id, personality_prompt, last_digest_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
            personality_prompt = ?,
            last_digest_at = CURRENT_TIMESTAMP
    `).run(guildId, newPrompt, newPrompt);
}

export function incrementInteractionCount(guildId) {
    const db = getDb();
    db.prepare(`
        INSERT INTO guild_personality (guild_id, personality_prompt, interaction_count)
        VALUES (?, '', 1)
        ON CONFLICT(guild_id) DO UPDATE SET
            interaction_count = interaction_count + 1
    `).run(guildId);

    const row = db.prepare('SELECT interaction_count FROM guild_personality WHERE guild_id = ?').get(guildId);
    return row.interaction_count;
}

export function shouldRunDigest(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT interaction_count FROM guild_personality WHERE guild_id = ?').get(guildId);
    if (!row) return false;
    return row.interaction_count % config.personalityDigestInterval === 0;
}
