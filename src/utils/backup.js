/**
 * Database Backup System
 *
 * Creates daily backups of bot.db with 10-day retention.
 * Runs entirely via source code — no AI model involvement.
 */

import { copyFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(PROJECT_ROOT, 'bot.db');
const BACKUP_DIR = join(PROJECT_ROOT, 'backups');
const MAX_BACKUPS = 10;

function ensureBackupDir() {
    if (!existsSync(BACKUP_DIR)) {
        mkdirSync(BACKUP_DIR, { recursive: true });
        logger.info('Created backup directory', { path: BACKUP_DIR });
    }
}

function getBackupFilename() {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return `bot-${date}.db`;
}

function purgeOldBackups() {
    const files = readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('bot-') && f.endsWith('.db'))
        .sort(); // Oldest first (lexicographic sort on YYYY-MM-DD)

    while (files.length > MAX_BACKUPS) {
        const oldest = files.shift();
        const fullPath = join(BACKUP_DIR, oldest);
        try {
            unlinkSync(fullPath);
            logger.info('Purged old backup', { file: oldest });
        } catch (err) {
            logger.error('Failed to purge backup', { file: oldest, error: err.message });
        }
    }
}

export function runBackup() {
    try {
        ensureBackupDir();

        if (!existsSync(DB_PATH)) {
            logger.warn('Database file not found, skipping backup', { path: DB_PATH });
            return;
        }

        const filename = getBackupFilename();
        const destPath = join(BACKUP_DIR, filename);

        // If today's backup already exists, skip
        if (existsSync(destPath)) {
            logger.debug('Backup for today already exists', { file: filename });
            return;
        }

        copyFileSync(DB_PATH, destPath);
        logger.info('Database backup created', { file: filename });

        purgeOldBackups();
    } catch (err) {
        logger.error('Backup failed', { error: err.message, stack: err.stack });
    }
}

/**
 * Start the daily backup scheduler.
 * Runs a backup immediately on startup, then every 24 hours.
 */
export function startBackupScheduler() {
    // Run immediately
    runBackup();

    // Then every 24 hours
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    setInterval(() => runBackup(), TWENTY_FOUR_HOURS);

    logger.info('Backup scheduler started (every 24h, 10-day retention)');
}
