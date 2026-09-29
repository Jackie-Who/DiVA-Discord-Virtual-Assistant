/**
 * Button role selectors: persistent messages whose buttons toggle roles.
 *
 * A selector is keyed by its Discord message ID. Options (one per role button)
 * live in role_selector_options and cascade-delete with the selector.
 *
 * Schema lives in src/db/init.js (v1.3 tables).
 */

import { getDb } from './init.js';

export const MAX_SELECTOR_OPTIONS = 25; // Discord: 5 action rows x 5 buttons

function toSelector(row) {
    if (!row) return null;
    return {
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        title: row.title,
        description: row.description,
        exclusive: row.exclusive === 1,
        createdBy: row.created_by,
        createdAt: row.created_at,
    };
}

function toOption(row) {
    return { roleId: row.role_id, emoji: row.emoji, label: row.label, position: row.position };
}

/**
 * Insert a selector and its options in one transaction.
 * @param {object} selector { messageId, guildId, channelId, title, description, exclusive, createdBy }
 * @param {Array<{roleId, emoji, label}>} options in display order
 */
export function createSelector(selector, options) {
    const db = getDb();
    const insertSelector = db.prepare(`
        INSERT INTO role_selectors
            (message_id, guild_id, channel_id, title, description, exclusive, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOption = db.prepare(`
        INSERT INTO role_selector_options (message_id, role_id, emoji, label, position)
        VALUES (?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
        insertSelector.run(
            selector.messageId, selector.guildId, selector.channelId,
            selector.title, selector.description || null,
            selector.exclusive ? 1 : 0, selector.createdBy
        );
        options.forEach((o, i) => insertOption.run(selector.messageId, o.roleId, o.emoji || null, o.label, i));
    })();
}

export function getSelector(messageId) {
    const db = getDb();
    return toSelector(db.prepare(`SELECT * FROM role_selectors WHERE message_id = ?`).get(messageId));
}

export function getSelectorOptions(messageId) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM role_selector_options WHERE message_id = ? ORDER BY position ASC
    `).all(messageId).map(toOption);
}

export function getSelectorOption(messageId, roleId) {
    const db = getDb();
    const row = db.prepare(`
        SELECT * FROM role_selector_options WHERE message_id = ? AND role_id = ?
    `).get(messageId, roleId);
    return row ? toOption(row) : null;
}

export function listSelectorsForGuild(guildId) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM role_selectors WHERE guild_id = ? ORDER BY created_at ASC
    `).all(guildId).map(toSelector);
}

/**
 * Replace a selector's full option list (used for add / remove / edit so the
 * positions are always contiguous and match the rendered button order).
 */
export function replaceSelectorOptions(messageId, options) {
    const db = getDb();
    const del = db.prepare(`DELETE FROM role_selector_options WHERE message_id = ?`);
    const ins = db.prepare(`
        INSERT INTO role_selector_options (message_id, role_id, emoji, label, position)
        VALUES (?, ?, ?, ?, ?)
    `);
    const touch = db.prepare(`UPDATE role_selectors SET updated_at = CURRENT_TIMESTAMP WHERE message_id = ?`);
    db.transaction(() => {
        del.run(messageId);
        options.forEach((o, i) => ins.run(messageId, o.roleId, o.emoji || null, o.label, i));
        touch.run(messageId);
    })();
}

export function updateSelectorMeta(messageId, { title, description, exclusive }) {
    const db = getDb();
    db.prepare(`
        UPDATE role_selectors
        SET title = COALESCE(?, title),
            description = CASE WHEN ? THEN ? ELSE description END,
            exclusive = COALESCE(?, exclusive),
            updated_at = CURRENT_TIMESTAMP
        WHERE message_id = ?
    `).run(
        title ?? null,
        description !== undefined ? 1 : 0,
        description === '' ? null : (description ?? null),
        exclusive === undefined ? null : (exclusive ? 1 : 0),
        messageId
    );
}

export function deleteSelector(messageId) {
    const db = getDb();
    return db.prepare(`DELETE FROM role_selectors WHERE message_id = ?`).run(messageId).changes;
}

/** Selector message IDs that include a given role (used when a role is deleted). */
export function getSelectorIdsForRole(roleId) {
    const db = getDb();
    return db.prepare(`
        SELECT DISTINCT message_id FROM role_selector_options WHERE role_id = ?
    `).all(roleId).map(r => r.message_id);
}
