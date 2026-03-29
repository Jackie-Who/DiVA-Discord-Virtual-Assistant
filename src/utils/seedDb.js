/**
 * One-time database seed for Railway.
 *
 * If DATA_DIR is set (Railway volume) and bot.db doesn't exist there yet,
 * downloads it from a temporary URL. Only runs once — after the file exists,
 * this is a no-op on every future deploy.
 *
 * DELETE THIS FILE after the seed is confirmed working.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import logger from './logger.js';

const DATA_DIR = process.env.DATA_DIR;
const SEED_URL = 'https://limewire.com/d/CBryR#zmTa3m3D5V';

export function seedDatabaseIfNeeded() {
    if (!DATA_DIR) return; // Local dev — skip

    const dbPath = join(DATA_DIR, 'bot.db');

    if (existsSync(dbPath)) {
        logger.info('Database already exists on volume, skipping seed');
        return;
    }

    logger.info('No database found on volume, downloading seed...');

    try {
        execSync(`curl -L -o "${dbPath}" "${SEED_URL}"`, { stdio: 'pipe', timeout: 30_000 });

        if (existsSync(dbPath)) {
            logger.info('Database seed downloaded successfully', { path: dbPath });
        } else {
            logger.error('Seed download completed but file not found');
        }
    } catch (err) {
        logger.error('Failed to download seed database', { error: err.message });
        // Bot will still start with a fresh DB — not fatal
    }
}
