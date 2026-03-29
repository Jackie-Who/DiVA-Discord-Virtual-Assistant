/**
 * Budget System Test Suite
 *
 * Tests all budget functions using a temporary in-memory database.
 * Zero API calls, zero token cost.
 *
 * Run: node tests/budget.test.js
 */

import Database from 'better-sqlite3';

// ── Set up an isolated in-memory DB so we don't touch the real one ──

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS monthly_budget (
        month_key TEXT PRIMARY KEY,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0.0,
        budget_limit_usd REAL NOT NULL
    );
`);

// ── Recreate budget functions against our test DB ──

const BUDGET_LIMIT = 20;
const INPUT_COST_PER_MILLION = 3;
const OUTPUT_COST_PER_MILLION = 15;

function getMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function recordUsage(guildId, userId, inputTokens, outputTokens) {
    const costUsd = (inputTokens / 1_000_000 * INPUT_COST_PER_MILLION) +
                    (outputTokens / 1_000_000 * OUTPUT_COST_PER_MILLION);
    const monthKey = getMonthKey();

    db.prepare(`INSERT INTO token_usage (guild_id, user_id, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)`)
      .run(guildId, userId, inputTokens, outputTokens, costUsd);

    db.prepare(`
        INSERT INTO monthly_budget (month_key, total_input_tokens, total_output_tokens, total_cost_usd, budget_limit_usd)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(month_key) DO UPDATE SET
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cost_usd = total_cost_usd + ?
    `).run(monthKey, inputTokens, outputTokens, costUsd, BUDGET_LIMIT, inputTokens, outputTokens, costUsd);
}

function getCurrentMonthUsage() {
    const row = db.prepare('SELECT * FROM monthly_budget WHERE month_key = ?').get(getMonthKey());
    if (!row) return { inputTokens: 0, outputTokens: 0, costUsd: 0, budgetLimitUsd: BUDGET_LIMIT, remainingUsd: BUDGET_LIMIT };
    return {
        inputTokens: row.total_input_tokens,
        outputTokens: row.total_output_tokens,
        costUsd: row.total_cost_usd,
        budgetLimitUsd: row.budget_limit_usd,
        remainingUsd: Math.max(0, row.budget_limit_usd - row.total_cost_usd),
    };
}

function isBudgetExhausted() {
    const u = getCurrentMonthUsage();
    return u.costUsd >= u.budgetLimitUsd;
}

function getBudgetPercent() {
    const u = getCurrentMonthUsage();
    if (u.budgetLimitUsd <= 0) return 100;
    return (u.costUsd / u.budgetLimitUsd) * 100;
}

function isInSavingMode() {
    return getBudgetPercent() >= 85;
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        console.log(`  ❌ ${testName}`);
    }
}

function assertClose(actual, expected, testName, tolerance = 0.0001) {
    assert(Math.abs(actual - expected) < tolerance, `${testName} (got ${actual}, expected ${expected})`);
}

// ── Tests ──

console.log('\n🧪 Budget System Tests\n');

// --- Test 1: Fresh month ---
console.log('📋 Fresh month (no usage):');
{
    const usage = getCurrentMonthUsage();
    assert(usage.inputTokens === 0, 'Input tokens = 0');
    assert(usage.outputTokens === 0, 'Output tokens = 0');
    assert(usage.costUsd === 0, 'Cost = $0');
    assert(usage.remainingUsd === 20, 'Remaining = $20');
    assert(usage.budgetLimitUsd === 20, 'Budget limit = $20');
    assert(!isBudgetExhausted(), 'Budget NOT exhausted');
    assert(!isInSavingMode(), 'Saving mode OFF');
    assertClose(getBudgetPercent(), 0, 'Budget percent = 0%');
}

// --- Test 2: Single small usage ---
console.log('\n📋 Single exchange (~average):');
{
    // Simulate a typical exchange: 800 input, 200 output
    recordUsage('guild-1', 'user-1', 800, 200);
    const usage = getCurrentMonthUsage();
    const expectedCost = (800 / 1_000_000 * 3) + (200 / 1_000_000 * 15); // $0.0054
    assertClose(usage.costUsd, expectedCost, `Cost = $${expectedCost.toFixed(6)}`);
    assert(usage.inputTokens === 800, 'Input tokens = 800');
    assert(usage.outputTokens === 200, 'Output tokens = 200');
    assert(!isBudgetExhausted(), 'Budget NOT exhausted');
    assert(!isInSavingMode(), 'Saving mode OFF');
    assertClose(getBudgetPercent(), (expectedCost / 20) * 100, 'Budget percent correct');
}

// --- Test 3: Accumulation across multiple guilds/users ---
console.log('\n📋 Multiple guilds accumulate into same month:');
{
    recordUsage('guild-1', 'user-2', 1000, 300);
    recordUsage('guild-2', 'user-3', 500, 100);
    const usage = getCurrentMonthUsage();
    assert(usage.inputTokens === 800 + 1000 + 500, 'Input tokens accumulated correctly');
    assert(usage.outputTokens === 200 + 300 + 100, 'Output tokens accumulated correctly');
}

// --- Test 4: Token usage rows tracked per guild/user ---
console.log('\n📋 Individual usage rows:');
{
    const rows = db.prepare('SELECT COUNT(*) as count FROM token_usage').get();
    assert(rows.count === 3, 'Three individual usage rows recorded');

    const guildRows = db.prepare("SELECT COUNT(*) as count FROM token_usage WHERE guild_id = 'guild-2'").get();
    assert(guildRows.count === 1, 'Guild-2 has 1 row');
}

// --- Test 5: Approach 85% threshold (saving mode) ---
console.log('\n📋 Saving mode at 85%:');
{
    // Current cost is small. Need to reach 85% of $20 = $17.
    // Record a big chunk: let's add enough to reach exactly 85%
    const current = getCurrentMonthUsage();
    const needed = (BUDGET_LIMIT * 0.85) - current.costUsd;
    // Use output tokens (expensive at $15/M) to reach target efficiently
    const outputTokensNeeded = Math.ceil((needed / 15) * 1_000_000);

    recordUsage('guild-1', 'user-1', 0, outputTokensNeeded);

    const pct = getBudgetPercent();
    assert(pct >= 85, `Budget at ${pct.toFixed(1)}% (>= 85%)`);
    assert(isInSavingMode(), 'Saving mode ON');
    assert(!isBudgetExhausted(), 'Budget NOT yet exhausted');
}

// --- Test 6: Hit 100% budget ---
console.log('\n📋 Budget exhaustion at 100%:');
{
    const current = getCurrentMonthUsage();
    const needed = current.budgetLimitUsd - current.costUsd + 0.01;
    const outputTokensNeeded = Math.ceil((needed / 15) * 1_000_000);

    recordUsage('guild-1', 'user-1', 0, outputTokensNeeded);

    assert(isBudgetExhausted(), 'Budget EXHAUSTED');
    assert(isInSavingMode(), 'Saving mode still ON');
    assert(getBudgetPercent() >= 100, `Budget at ${getBudgetPercent().toFixed(1)}%`);

    const usage = getCurrentMonthUsage();
    assert(usage.remainingUsd === 0, 'Remaining = $0');
}

// --- Test 7: Cost calculation precision ---
console.log('\n📋 Cost calculation precision:');
{
    // Verify exact cost formula
    const inputTokens = 1_000_000;
    const outputTokens = 1_000_000;
    const expectedCost = (inputTokens / 1_000_000 * 3) + (outputTokens / 1_000_000 * 15);
    assertClose(expectedCost, 18, 'Cost of 1M input + 1M output = $18');

    // Small amounts
    const smallCost = (100 / 1_000_000 * 3) + (50 / 1_000_000 * 15);
    assertClose(smallCost, 0.001050, 'Cost of 100 input + 50 output = $0.00105');
}

// --- Test 8: Month key format ---
console.log('\n📋 Month key format:');
{
    const key = getMonthKey();
    assert(/^\d{4}-\d{2}$/.test(key), `Month key "${key}" matches YYYY-MM`);
    const [year, month] = key.split('-').map(Number);
    assert(year >= 2024 && year <= 2030, 'Year is reasonable');
    assert(month >= 1 && month <= 12, 'Month 1-12');
}

// --- Test 9: Different month isolation ---
console.log('\n📋 Month isolation:');
{
    // Manually insert a row for a different month
    db.prepare(`
        INSERT INTO monthly_budget (month_key, total_input_tokens, total_output_tokens, total_cost_usd, budget_limit_usd)
        VALUES ('2025-01', 999999, 999999, 99.99, 20)
    `).run();

    // Current month usage should NOT include the 2025-01 data
    const usage = getCurrentMonthUsage();
    assert(usage.costUsd < 25, 'Current month not polluted by other months');

    const oldRow = db.prepare("SELECT * FROM monthly_budget WHERE month_key = '2025-01'").get();
    assert(oldRow.total_cost_usd === 99.99, 'Old month data preserved separately');
}

// ── Results ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'─'.repeat(40)}\n`);

db.close();

process.exit(failed > 0 ? 1 : 0);
