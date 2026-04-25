/**
 * Per-guild credit management.
 *
 * Replaces the v1.0 global monthly_budget model. Each guild has a lifetime balance
 * (lifetime_credits_usd) and a cumulative spend total (total_spent_usd). When spend
 * meets or exceeds lifetime, the guild is "out of credits" and AI replies pause.
 *
 * The owner_managed flag bypasses out-of-credits checks for guilds the bot owner
 * runs themselves (free / subsidized servers).
 *
 * Per-message AI spend is recorded in `token_usage` (kept for analytics). This
 * file owns the lifetime/spend ledger and the audit log of credit_transactions.
 */

import { getDb } from './init.js';
import logger from '../utils/logger.js';

// Saving mode threshold: at or above this percent of lifetime credits spent,
// the bot disables web search and image analysis to stretch what's left.
const SAVING_MODE_PERCENT = 85;

// Out-of-credits notice cooldown — bot will only post the OOF message once
// every N minutes per guild to avoid spam.
const OOF_COOLDOWN_MINUTES = 60 * 24; // 24h

/**
 * Ensure a guild has a row in guild_credits. New guilds default to $0/$0 — they
 * cannot use the bot until credits are added (intentional gating for paid product).
 */
export function ensureGuildCreditsRow(guildId) {
    const db = getDb();
    db.prepare(`
        INSERT OR IGNORE INTO guild_credits (guild_id, lifetime_credits_usd, total_spent_usd)
        VALUES (?, 0.0, 0.0)
    `).run(guildId);
}

/**
 * Add `amountUsd` to a guild's spend total. Atomic.
 * Called from recordUsage() in tokenBudget.js for every API call.
 */
export function addSpend(guildId, amountUsd) {
    if (amountUsd <= 0) return;
    const db = getDb();
    ensureGuildCreditsRow(guildId);
    db.prepare(`
        UPDATE guild_credits
        SET total_spent_usd = total_spent_usd + ?
        WHERE guild_id = ?
    `).run(amountUsd, guildId);
}

/**
 * Add credits (top-up). Inserts a transaction row for the audit log.
 * @param {string} guildId
 * @param {number} amountUsd  positive number of USD to add
 * @param {string} actorUserId  who triggered this (owner ID for /credits add, 'stripe' for webhook)
 * @param {string} note  free-text reason
 * @returns {object} { newBalance, newLifetime }
 */
export function topUp(guildId, amountUsd, actorUserId = '', note = '') {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        throw new Error('topUp amount must be a positive number');
    }
    const db = getDb();
    ensureGuildCreditsRow(guildId);

    const txn = db.transaction(() => {
        db.prepare(`
            UPDATE guild_credits
            SET lifetime_credits_usd = lifetime_credits_usd + ?,
                last_topup_at = CURRENT_TIMESTAMP
            WHERE guild_id = ?
        `).run(amountUsd, guildId);

        db.prepare(`
            INSERT INTO credit_transactions (guild_id, kind, amount_usd, actor_user_id, note)
            VALUES (?, 'topup', ?, ?, ?)
        `).run(guildId, amountUsd, actorUserId, note);

        return getGuildCreditUsage(guildId);
    });

    const result = txn();
    logger.info('Credits topped up', { guildId, amountUsd, actorUserId, note, newRemaining: result.remainingUsd });
    return { newBalance: result.remainingUsd, newLifetime: result.lifetimeCreditsUsd };
}

/**
 * Get the credit state for a guild.
 * @returns {object} { lifetimeCreditsUsd, totalSpentUsd, remainingUsd, ownerManaged, lastOofNoticeAt }
 */
export function getGuildCreditUsage(guildId) {
    const db = getDb();
    const row = db.prepare(`
        SELECT lifetime_credits_usd, total_spent_usd, owner_managed, last_oof_notice_at
        FROM guild_credits WHERE guild_id = ?
    `).get(guildId);

    if (!row) {
        return {
            lifetimeCreditsUsd: 0,
            totalSpentUsd: 0,
            remainingUsd: 0,
            ownerManaged: false,
            lastOofNoticeAt: null,
        };
    }

    return {
        lifetimeCreditsUsd: row.lifetime_credits_usd,
        totalSpentUsd: row.total_spent_usd,
        remainingUsd: Math.max(0, row.lifetime_credits_usd - row.total_spent_usd),
        ownerManaged: row.owner_managed === 1,
        lastOofNoticeAt: row.last_oof_notice_at,
    };
}

/**
 * Returns true if a guild has run out of credits.
 * Owner-managed guilds always return false.
 */
export function isGuildOutOfCredits(guildId) {
    const usage = getGuildCreditUsage(guildId);
    if (usage.ownerManaged) return false;
    return usage.totalSpentUsd >= usage.lifetimeCreditsUsd;
}

/**
 * Percent of lifetime credits spent (0-100+).
 * Owner-managed guilds always return 0.
 */
export function getGuildSpendPercent(guildId) {
    const usage = getGuildCreditUsage(guildId);
    if (usage.ownerManaged) return 0;
    if (usage.lifetimeCreditsUsd <= 0) return 100;
    return (usage.totalSpentUsd / usage.lifetimeCreditsUsd) * 100;
}

/**
 * True when the guild is at or above the saving-mode threshold (default 85%).
 * Owner-managed guilds always return false.
 */
export function isGuildInSavingMode(guildId) {
    return getGuildSpendPercent(guildId) >= SAVING_MODE_PERCENT;
}

/**
 * Should we post the out-of-credits notice right now? Returns true at most
 * once per OOF_COOLDOWN_MINUTES per guild.
 *
 * If true, immediately marks last_oof_notice_at to the current timestamp so
 * subsequent calls within the cooldown window return false.
 */
export function tryClaimOofNotice(guildId) {
    const db = getDb();
    const result = db.prepare(`
        UPDATE guild_credits
        SET last_oof_notice_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
          AND (last_oof_notice_at IS NULL
               OR last_oof_notice_at < datetime('now', ?))
    `).run(guildId, `-${OOF_COOLDOWN_MINUTES} minutes`);
    return result.changes > 0;
}

/**
 * Set or clear the owner_managed flag on a guild. Used to mark guilds where
 * out-of-credits checks should be bypassed (e.g., the bot owner's own servers).
 */
export function setOwnerManaged(guildId, ownerManaged) {
    const db = getDb();
    ensureGuildCreditsRow(guildId);
    db.prepare(`
        UPDATE guild_credits SET owner_managed = ? WHERE guild_id = ?
    `).run(ownerManaged ? 1 : 0, guildId);
    logger.info('Owner-managed flag updated', { guildId, ownerManaged });
}

/**
 * Recent transactions (last 30 days) for display in /credits.
 */
export function getRecentTransactions(guildId, limit = 10) {
    const db = getDb();
    return db.prepare(`
        SELECT kind, amount_usd, actor_user_id, note, created_at
        FROM credit_transactions
        WHERE guild_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(guildId, limit);
}

/**
 * Recent token spend for display in /budget.
 */
export function getRecentSpend(guildId, days = 30) {
    const db = getDb();
    return db.prepare(`
        SELECT
            DATE(created_at) AS day,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS cost_usd,
            COUNT(*) AS calls
        FROM token_usage
        WHERE guild_id = ? AND created_at > datetime('now', ?)
        GROUP BY DATE(created_at)
        ORDER BY day DESC
    `).all(guildId, `-${days} days`);
}
