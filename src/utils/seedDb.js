/**
 * One-time database seed for Railway.
 *
 * If DATA_DIR is set (Railway volume) and bot.db doesn't exist there yet,
 * downloads it from a temporary URL. Only runs once — after the file exists,
 * this is a no-op on every future deploy.
 *
 * DELETE THIS FILE after the seed is confirmed working.
 */

import { existsSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import logger from './logger.js';

const DATA_DIR = process.env.DATA_DIR;
const SEED_URL = 'https://limewire.com/d/CBryR#zmTa3m3D5V';

export function seedDatabaseIfNeeded() {
    if (!DATA_DIR) return; // Local dev — skip

    const dbPath = join(DATA_DIR, 'bot.db');

    // Check if DB exists AND has real data (>8KB means it has personality rows)
    // A freshly created empty DB is ~4KB
    if (existsSync(dbPath)) {
        const size = statSync(dbPath).size;
        if (size > 8192) {
            logger.info('Database with data exists on volume, skipping seed', { size });
            return;
        }
        // Empty/fresh DB — delete it so we can replace with the seed
        logger.info('Empty database found on volume, replacing with seed...', { size });
        unlinkSync(dbPath);
    }

    logger.info('Downloading seed database...');

    try {
        execSync(`curl -L -o "${dbPath}" "${SEED_URL}"`, { stdio: 'pipe', timeout: 30_000 });

        if (existsSync(dbPath)) {
            const size = statSync(dbPath).size;
            logger.info('Database seed downloaded successfully', { path: dbPath, size });
        } else {
            logger.error('Seed download completed but file not found');
        }
    } catch (err) {
        logger.error('Failed to download seed database', { error: err.message });
    }
}
