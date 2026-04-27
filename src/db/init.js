import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

// Use DATA_DIR env var (Railway volume) or fall back to project root (local dev)
const DATA_DIR = process.env.DATA_DIR || PROJECT_ROOT;
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Dev uses a separate database file so we can never accidentally touch prod data.
// Prod (BOT_ENV=production) and any deployment without BOT_ENV use 'bot.db'.
const BOT_ENV = (process.env.BOT_ENV || 'development').toLowerCase();
const DB_FILENAME = BOT_ENV === 'development' ? 'bot.dev.db' : 'bot.db';
const DB_PATH = join(DATA_DIR, DB_FILENAME);

export { DB_PATH, DATA_DIR };

let db;

export function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initTables();
        logger.info('Database initialized', { path: DB_PATH });
    }
    return db;
}

function initTables() {
    db.exec(`
        -- ── Existing tables (v1.0/1.1 schema, untouched) ──

        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cost_usd REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_token_usage_month ON token_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_token_usage_guild ON token_usage(guild_id, created_at DESC);

        -- monthly_budget kept for historical reads; v1.2 stops writing to it.
        CREATE TABLE IF NOT EXISTS monthly_budget (
            month_key TEXT PRIMARY KEY,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cost_usd REAL DEFAULT 0.0,
            budget_limit_usd REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            user_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conversations_lookup
        ON conversations(guild_id, channel_id, user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS guild_personality (
            guild_id TEXT PRIMARY KEY,
            personality_prompt TEXT NOT NULL DEFAULT '',
            interaction_count INTEGER DEFAULT 0,
            last_digest_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS undo_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            confirm_msg_id TEXT NOT NULL,
            action_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_undo_actions_lookup
        ON undo_actions(guild_id, user_id, confirm_msg_id);

        -- ── v1.2 tables ──

        -- Per-guild credit balances. Replaces the global monthly_budget model.
        CREATE TABLE IF NOT EXISTS guild_credits (
            guild_id TEXT PRIMARY KEY,
            lifetime_credits_usd REAL NOT NULL DEFAULT 0.0,
            total_spent_usd REAL NOT NULL DEFAULT 0.0,
            owner_managed INTEGER NOT NULL DEFAULT 0,
            last_topup_at DATETIME,
            last_oof_notice_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Audit log for every credit movement (top-ups, refunds, owner adjustments).
        -- Per-message AI spend is in token_usage; we don't double-write to keep this lean.
        CREATE TABLE IF NOT EXISTS credit_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('topup', 'refund', 'adjustment', 'migration')),
            amount_usd REAL NOT NULL,
            actor_user_id TEXT,
            note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_credit_tx_guild
        ON credit_transactions(guild_id, created_at DESC);

        -- Per-user preferences (timezone + secretary mode + delivery preferences).
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            timezone TEXT,
            delivery_mode TEXT,
            delivery_channel_id TEXT,
            secretary_enabled INTEGER NOT NULL DEFAULT 0,
            secretary_time_local TEXT,
            last_digest_sent_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Reminders. One row per scheduled fire; recurring rules generate a new row
        -- each time they fire (linked via parent_id).
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            fire_at_utc DATETIME NOT NULL,
            message TEXT NOT NULL,
            recurrence TEXT,
            weekday INTEGER,
            fire_time_local TEXT,
            parent_id INTEGER,
            fired_at DATETIME,
            cancelled_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_pending
        ON reminders(fire_at_utc) WHERE fired_at IS NULL AND cancelled_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_reminders_user
        ON reminders(user_id, fire_at_utc DESC);

        -- Per-guild channel routing (errors, metrics, update notices) + notice opt-out.
        CREATE TABLE IF NOT EXISTS guild_channels (
            guild_id TEXT PRIMARY KEY,
            error_channel_id TEXT,
            metrics_channel_id TEXT,
            notices_channel_id TEXT,
            notices_enabled INTEGER NOT NULL DEFAULT 1,
            weekly_metrics_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Generic key-value bot metadata (e.g., last_announced_version for update notices).
        CREATE TABLE IF NOT EXISTS bot_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    runMigrations();
}

/**
 * Add a column to a table if it doesn't already exist.
 * SQLite's ALTER TABLE ADD COLUMN throws if the column exists, so we check first.
 */
function addColumnIfMissing(table, column, definition) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        logger.info('Added column', { table, column });
    }
}

// One-time migrations. Idempotent — safe to run on every startup.
function runMigrations() {
    // v1.2.1: snooze_until_utc on reminders. When a user clicks "Snooze" on a
    // pre-fire notification, we set this to (fire_at_utc - 30min) so a follow-up
    // ping fires 30 minutes before the actual reminder. Cleared when the snooze
    // ping fires or the reminder is cancelled. Persisted so snoozes survive
    // bot restarts.
    addColumnIfMissing('reminders', 'snooze_until_utc', 'DATETIME');

    // v1.2: seed guild_credits for existing prod guilds based on observed spend.
    // Decision logged in plan: each prod guild starts at $18.875 lifetime / $2.00 spent.
    //
    // Skipped on dev — dev gets a small per-guild seed so the out-of-credits flow
    // can be exercised quickly. Each guild the dev bot is in starts at $1.00 lifetime
    // (~3-5 Sonnet exchanges before OOF triggers).
    const isDev = BOT_ENV === 'development';

    const insertCredit = db.prepare(`
        INSERT OR IGNORE INTO guild_credits
            (guild_id, lifetime_credits_usd, total_spent_usd, last_topup_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const insertTx = db.prepare(`
        INSERT INTO credit_transactions (guild_id, kind, amount_usd, note)
        VALUES (?, 'migration', ?, ?)
    `);

    const seeds = isDev
        // Dev: seed every configured guild with a small testable balance.
        ? (process.env.DISCORD_GUILD_IDS || '').split(',').map(id => id.trim()).filter(Boolean).map(guildId => ({
            guildId,
            lifetimeUsd: 1.00,
            spentUsd: 0.00,
            note: 'dev seed (small balance for OOF testing)',
        }))
        // Prod: documented seeds from clarifying Q&A.
        : [
            { guildId: '1482920276587974859', lifetimeUsd: 18.875, spentUsd: 2.00, note: 'v1.2 migration: prod guild A initial seed' },
            { guildId: '1481717242985971782', lifetimeUsd: 18.875, spentUsd: 2.00, note: 'v1.2 migration: prod guild B initial seed' },
        ];

    const txn = db.transaction(() => {
        for (const seed of seeds) {
            const result = insertCredit.run(seed.guildId, seed.lifetimeUsd, seed.spentUsd);
            if (result.changes > 0) {
                insertTx.run(seed.guildId, seed.lifetimeUsd, seed.note);
                logger.info('Seeded guild_credits', {
                    env: BOT_ENV,
                    guildId: seed.guildId,
                    lifetimeUsd: seed.lifetimeUsd,
                    spentUsd: seed.spentUsd,
                });
            }
        }
    });
    txn();
}

export default getDb;
