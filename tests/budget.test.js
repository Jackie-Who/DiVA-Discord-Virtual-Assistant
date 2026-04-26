/**
 * Per-Guild Credit System Test Suite (v1.2)
 *
 * Tests the credit logic against an isolated in-memory database so we don't touch
 * the real bot.db. The functions tested mirror src/db/credits.js and
 * src/db/tokenBudget.js — when those change, this file must move in lockstep.
 *
 * Zero API calls, zero token cost.
 *
 * Run: node tests/budget.test.js
 */

import Database from 'better-sqlite3';

// ── Set up an isolated in-memory DB ──

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
    CREATE TABLE IF NOT EXISTS guild_credits (
        guild_id TEXT PRIMARY KEY,
        lifetime_credits_usd REAL NOT NULL DEFAULT 0.0,
        total_spent_usd REAL NOT NULL DEFAULT 0.0,
        owner_managed INTEGER NOT NULL DEFAULT 0,
        last_topup_at DATETIME,
        last_oof_notice_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('topup', 'refund', 'adjustment', 'migration')),
        amount_usd REAL NOT NULL,
        actor_user_id TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ── Recreate credit functions inline against the in-memory DB ──

const SAVING_MODE_PERCENT = 85;
const OOF_COOLDOWN_MINUTES = 60 * 24;

const MODEL_PRICING = {
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

function ensureRow(guildId) {
    db.prepare(`
        INSERT OR IGNORE INTO guild_credits (guild_id, lifetime_credits_usd, total_spent_usd)
        VALUES (?, 0.0, 0.0)
    `).run(guildId);
}

function topUp(guildId, amountUsd, actorUserId = '', note = '') {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        throw new Error('topUp amount must be positive');
    }
    ensureRow(guildId);
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
    });
    txn();
}

function recordUsage(guildId, userId, inputTokens, outputTokens, model) {
    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    const cost = (inputTokens / 1e6 * pricing.input) + (outputTokens / 1e6 * pricing.output);
    db.prepare(`
        INSERT INTO token_usage (guild_id, user_id, input_tokens, output_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?)
    `).run(guildId, userId, inputTokens, outputTokens, cost);
    ensureRow(guildId);
    db.prepare(`UPDATE guild_credits SET total_spent_usd = total_spent_usd + ? WHERE guild_id = ?`)
      .run(cost, guildId);
    return cost;
}

function getGuildCreditUsage(guildId) {
    const row = db.prepare(`SELECT * FROM guild_credits WHERE guild_id = ?`).get(guildId);
    if (!row) return { lifetimeCreditsUsd: 0, totalSpentUsd: 0, remainingUsd: 0, ownerManaged: false };
    return {
        lifetimeCreditsUsd: row.lifetime_credits_usd,
        totalSpentUsd: row.total_spent_usd,
        remainingUsd: Math.max(0, row.lifetime_credits_usd - row.total_spent_usd),
        ownerManaged: row.owner_managed === 1,
    };
}

function isGuildOutOfCredits(guildId) {
    const u = getGuildCreditUsage(guildId);
    if (u.ownerManaged) return false;
    return u.totalSpentUsd >= u.lifetimeCreditsUsd;
}

function getGuildSpendPercent(guildId) {
    const u = getGuildCreditUsage(guildId);
    if (u.ownerManaged) return 0;
    if (u.lifetimeCreditsUsd <= 0) return 100;
    return (u.totalSpentUsd / u.lifetimeCreditsUsd) * 100;
}

function isGuildInSavingMode(guildId) {
    return getGuildSpendPercent(guildId) >= SAVING_MODE_PERCENT;
}

function setOwnerManaged(guildId, flag) {
    ensureRow(guildId);
    db.prepare(`UPDATE guild_credits SET owner_managed = ? WHERE guild_id = ?`).run(flag ? 1 : 0, guildId);
}

function tryClaimOofNotice(guildId) {
    const result = db.prepare(`
        UPDATE guild_credits
        SET last_oof_notice_at = CURRENT_TIMESTAMP
        WHERE guild_id = ?
          AND (last_oof_notice_at IS NULL OR last_oof_notice_at < datetime('now', ?))
    `).run(guildId, `-${OOF_COOLDOWN_MINUTES} minutes`);
    return result.changes > 0;
}

// ── Test runner ──

let passed = 0, failed = 0;

function assert(cond, name) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else      { failed++; console.log(`  ❌ ${name}`); }
}

function assertClose(actual, expected, name, tol = 1e-4) {
    assert(Math.abs(actual - expected) < tol, `${name} (got ${actual}, expected ${expected})`);
}

console.log('\n🧪 Per-Guild Credit System Tests (v1.2)\n');

// --- Test 1: Fresh guild ---
console.log('📋 Fresh guild (no row yet):');
{
    const u = getGuildCreditUsage('guild-fresh');
    assertClose(u.lifetimeCreditsUsd, 0, 'lifetime = 0');
    assertClose(u.totalSpentUsd, 0, 'spent = 0');
    assertClose(u.remainingUsd, 0, 'remaining = 0');
    assert(!u.ownerManaged, 'ownerManaged = false');
    assert(isGuildOutOfCredits('guild-fresh'), 'OOF since 0 ≥ 0');
}

// --- Test 2: Top-up creates a balance ---
console.log('\n📋 Top-up:');
{
    topUp('guild-A', 5.00, 'owner-1', 'initial');
    const u = getGuildCreditUsage('guild-A');
    assertClose(u.lifetimeCreditsUsd, 5.00, 'lifetime = $5');
    assertClose(u.totalSpentUsd, 0, 'spent = $0');
    assertClose(u.remainingUsd, 5.00, 'remaining = $5');
    assert(!isGuildOutOfCredits('guild-A'), 'NOT OOF after top-up');

    const txns = db.prepare(`SELECT * FROM credit_transactions WHERE guild_id = 'guild-A'`).all();
    assert(txns.length === 1, 'Audit row written');
    assert(txns[0].kind === 'topup', 'kind = topup');
    assertClose(txns[0].amount_usd, 5.00, 'amount = $5');
}

// --- Test 3: Single Sonnet usage ---
console.log('\n📋 Single Sonnet exchange (800 in, 200 out):');
{
    const cost = recordUsage('guild-A', 'user-1', 800, 200, 'claude-sonnet-4-6');
    const expected = (800 / 1e6 * 3) + (200 / 1e6 * 15); // $0.0054
    assertClose(cost, expected, `Cost = $${expected.toFixed(6)}`);
    const u = getGuildCreditUsage('guild-A');
    assertClose(u.totalSpentUsd, expected, 'Spent updated');
    assertClose(u.remainingUsd, 5.00 - expected, 'Remaining decreased correctly');
}

// --- Test 4: Haiku is cheaper ---
console.log('\n📋 Haiku pricing (1/3 of Sonnet):');
{
    const sonnetCost = (1000 / 1e6 * 3) + (500 / 1e6 * 15);
    const haikuCost  = (1000 / 1e6 * 1) + (500 / 1e6 * 5);
    assertClose(sonnetCost, 0.0105, 'Sonnet 1k/500 = $0.0105');
    assertClose(haikuCost, 0.0035, 'Haiku 1k/500 = $0.0035');
    assert(haikuCost < sonnetCost, 'Haiku cheaper than Sonnet for same tokens');
}

// --- Test 5: Per-guild isolation ---
console.log('\n📋 Per-guild isolation:');
{
    topUp('guild-B', 10.00, 'owner-1', 'initial-B');
    recordUsage('guild-B', 'user-2', 100, 100, 'claude-haiku-4-5-20251001');
    const a = getGuildCreditUsage('guild-A');
    const b = getGuildCreditUsage('guild-B');
    assert(a.lifetimeCreditsUsd === 5.00, 'guild-A lifetime unchanged');
    assert(b.lifetimeCreditsUsd === 10.00, 'guild-B lifetime separate');
    assert(b.totalSpentUsd > 0 && b.totalSpentUsd < a.totalSpentUsd + 0.01, 'guild-B has its own spend');
}

// --- Test 6: Saving mode at 85% ---
console.log('\n📋 Saving mode at 85%:');
{
    // Top off guild-C to a known balance, then spend ~85% of it
    topUp('guild-C', 1.00, 'owner-1', 'sm-test');
    const target = 1.00 * 0.85;
    const tokensNeeded = Math.ceil((target / 15) * 1e6);
    recordUsage('guild-C', 'user-3', 0, tokensNeeded, 'claude-sonnet-4-6');
    const pct = getGuildSpendPercent('guild-C');
    assert(pct >= 85, `guild-C spend = ${pct.toFixed(1)}% (≥85)`);
    assert(isGuildInSavingMode('guild-C'), 'Saving mode ON');
    assert(!isGuildOutOfCredits('guild-C'), 'Not yet OOF (still some left)');
}

// --- Test 7: Out of credits ---
console.log('\n📋 Out of credits at 100%:');
{
    // Drive guild-C to fully exhaust
    const u = getGuildCreditUsage('guild-C');
    const remaining = u.remainingUsd + 0.01;
    const tokensNeeded = Math.ceil((remaining / 15) * 1e6);
    recordUsage('guild-C', 'user-3', 0, tokensNeeded, 'claude-sonnet-4-6');
    assert(isGuildOutOfCredits('guild-C'), 'guild-C is now OOF');
    assert(getGuildCreditUsage('guild-C').remainingUsd === 0, 'remaining = $0');
}

// --- Test 8: Owner-managed bypass ---
console.log('\n📋 Owner-managed bypass:');
{
    setOwnerManaged('guild-C', true);
    assert(!isGuildOutOfCredits('guild-C'), 'OOF check bypassed when owner_managed=1');
    assertClose(getGuildSpendPercent('guild-C'), 0, 'Spend percent reports 0 when owner-managed');
    assert(!isGuildInSavingMode('guild-C'), 'Saving mode OFF when owner-managed');
    setOwnerManaged('guild-C', false);
    assert(isGuildOutOfCredits('guild-C'), 'OOF returns once owner_managed cleared');
}

// --- Test 9: OOF notice rate limit ---
console.log('\n📋 OOF notice cooldown:');
{
    const first = tryClaimOofNotice('guild-C');
    assert(first === true, 'First claim succeeds');
    const second = tryClaimOofNotice('guild-C');
    assert(second === false, 'Second claim within cooldown returns false');
}

// --- Test 10: Top-up rejects bad input ---
console.log('\n📋 Top-up validation:');
{
    let threw = false;
    try { topUp('guild-D', 0); } catch { threw = true; }
    assert(threw, 'Throws on amount=0');
    threw = false;
    try { topUp('guild-D', -5); } catch { threw = true; }
    assert(threw, 'Throws on negative amount');
    threw = false;
    try { topUp('guild-D', NaN); } catch { threw = true; }
    assert(threw, 'Throws on NaN');
}

// --- Test 11: Cost formula precision ---
console.log('\n📋 Cost formula precision:');
{
    const sonnet1M = (1e6 / 1e6 * 3) + (1e6 / 1e6 * 15);
    assertClose(sonnet1M, 18, '1M/1M Sonnet = $18');
    const haiku1M = (1e6 / 1e6 * 1) + (1e6 / 1e6 * 5);
    assertClose(haiku1M, 6, '1M/1M Haiku = $6');
    const small = (100 / 1e6 * 3) + (50 / 1e6 * 15);
    assertClose(small, 0.00105, '100/50 Sonnet = $0.00105');
}

// --- Test 12: Token usage rows recorded per-guild ---
console.log('\n📋 token_usage row count:');
{
    const guildARows = db.prepare(`SELECT COUNT(*) as count FROM token_usage WHERE guild_id = 'guild-A'`).get();
    const guildBRows = db.prepare(`SELECT COUNT(*) as count FROM token_usage WHERE guild_id = 'guild-B'`).get();
    assert(guildARows.count === 1, 'guild-A has 1 token_usage row');
    assert(guildBRows.count === 1, 'guild-B has 1 token_usage row');
}

// ── Results ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'─'.repeat(40)}\n`);

db.close();
process.exit(failed > 0 ? 1 : 0);
