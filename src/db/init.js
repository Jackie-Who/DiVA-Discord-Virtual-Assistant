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

const DB_PATH = join(DATA_DIR, 'bot.db');

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
    `);
}

export default getDb;
