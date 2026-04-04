import { getDb } from './init.js';
import config from '../config.js';
import logger from '../utils/logger.js';

// Model pricing tiers (USD per million tokens)
const MODEL_PRICING = {
    'claude-sonnet-4-6':        { input: 3,  output: 15 },
    'claude-haiku-4-5-20251001': { input: 1,  output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 }; // fallback to Sonnet pricing

export function getMonthKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

export function recordUsage(guildId, userId, inputTokens, outputTokens, model) {
    const db = getDb();
    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    const costUsd = (inputTokens / 1_000_000 * pricing.input) +
                    (outputTokens / 1_000_000 * pricing.output);
    const monthKey = getMonthKey();

    db.prepare(`
        INSERT INTO token_usage (guild_id, user_id, input_tokens, output_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?)
    `).run(guildId, userId, inputTokens, outputTokens, costUsd);

    db.prepare(`
        INSERT INTO monthly_budget (month_key, total_input_tokens, total_output_tokens, total_cost_usd, budget_limit_usd)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(month_key) DO UPDATE SET
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cost_usd = total_cost_usd + ?
    `).run(monthKey, inputTokens, outputTokens, costUsd, config.monthlyTokenBudgetUsd,
           inputTokens, outputTokens, costUsd);

    logger.debug('Token usage recorded', {
        guildId, userId, inputTokens, outputTokens, costUsd: costUsd.toFixed(6)
    });
}

export function getCurrentMonthUsage() {
    const db = getDb();
    const monthKey = getMonthKey();

    const row = db.prepare(`
        SELECT total_input_tokens, total_output_tokens, total_cost_usd, budget_limit_usd
        FROM monthly_budget WHERE month_key = ?
    `).get(monthKey);

    if (!row) {
        return {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            budgetLimitUsd: config.monthlyTokenBudgetUsd,
            remainingUsd: config.monthlyTokenBudgetUsd,
        };
    }

    return {
        inputTokens: row.total_input_tokens,
        outputTokens: row.total_output_tokens,
        costUsd: row.total_cost_usd,
        budgetLimitUsd: row.budget_limit_usd,
        remainingUsd: Math.max(0, row.budget_limit_usd - row.total_cost_usd),
    };
}

export function isBudgetExhausted() {
    const usage = getCurrentMonthUsage();
    return usage.costUsd >= usage.budgetLimitUsd;
}

export function getBudgetPercent() {
    const usage = getCurrentMonthUsage();
    if (usage.budgetLimitUsd <= 0) return 100;
    return (usage.costUsd / usage.budgetLimitUsd) * 100;
}

export function isInSavingMode() {
    return getBudgetPercent() >= 85;
}
