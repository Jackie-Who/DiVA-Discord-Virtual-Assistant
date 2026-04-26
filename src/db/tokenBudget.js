/**
 * Token usage recording + thin compatibility layer over per-guild credits (v1.2+).
 *
 * v1.0/1.1 used a global monthly budget with `monthly_budget`/`getCurrentMonthUsage`.
 * v1.2 switched to per-guild lifetime credits — see `src/db/credits.js`. This file:
 *   - still owns recordUsage() (writes to token_usage and decrements credits)
 *   - re-exports the per-guild credit checks under their old names where useful
 */

import { getDb } from './init.js';
import logger from '../utils/logger.js';
import {
    addSpend,
    isGuildOutOfCredits,
    getGuildSpendPercent,
    isGuildInSavingMode,
    getGuildCreditUsage,
} from './credits.js';

// Model pricing tiers (USD per million tokens)
const MODEL_PRICING = {
    'claude-sonnet-4-6':         { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 }; // fallback to Sonnet pricing

/**
 * Record a single API call's usage. Writes to:
 *   - token_usage: per-call audit row (used for /budget trends and weekly metrics)
 *   - guild_credits: increments total_spent_usd
 */
export function recordUsage(guildId, userId, inputTokens, outputTokens, model) {
    const db = getDb();
    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    const costUsd = (inputTokens / 1_000_000 * pricing.input) +
                    (outputTokens / 1_000_000 * pricing.output);

    db.prepare(`
        INSERT INTO token_usage (guild_id, user_id, input_tokens, output_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?)
    `).run(guildId, userId, inputTokens, outputTokens, costUsd);

    addSpend(guildId, costUsd);

    logger.debug('Token usage recorded', {
        guildId, userId, model, inputTokens, outputTokens, costUsd: costUsd.toFixed(6),
    });
}

// ── Per-guild credit checks (re-exported for callers that import from tokenBudget.js) ──
//
// New code should import these directly from './credits.js'. These re-exports keep
// the call sites in chat.js / messageCreate.js / personality.js / weeklyMetrics.js
// from needing two import lines.

export {
    isGuildOutOfCredits,
    getGuildSpendPercent,
    isGuildInSavingMode,
    getGuildCreditUsage,
};
