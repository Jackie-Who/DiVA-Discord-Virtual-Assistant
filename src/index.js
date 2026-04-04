import { Client, GatewayIntentBits, Partials } from 'discord.js';
import config from './config.js';
import logger from './utils/logger.js';
import { initErrorNotifier, notifyError } from './utils/errorNotifier.js';
import { getDb } from './db/init.js';
import { startBackupScheduler } from './utils/backup.js';
import { cleanupExpiredUndoActions } from './ai/adminTools.js';
import { initWeeklyMetrics } from './utils/weeklyMetrics.js';
import ready from './events/ready.js';
import messageCreate from './events/messageCreate.js';
import interactionCreate from './events/interactionCreate.js';

// Set log level
logger.setLevel(config.logLevel);

// Initialize database
getDb();

// Start daily DB backup scheduler (10-day retention)
startBackupScheduler();

// Clean up expired undo actions every 5 minutes
setInterval(() => cleanupExpiredUndoActions(), 5 * 60_000);

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
});

// Initialize error notifier with the client (so it can send to Discord)
initErrorNotifier(client);

// Initialize weekly metrics (Sunday 9 PM Pacific)
initWeeklyMetrics(client);

// Register event handlers
ready(client);
messageCreate(client);
interactionCreate(client);

// Global error handlers
process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection', { error: error?.message, stack: error?.stack });
    notifyError({ title: 'Unhandled Rejection', error });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    notifyError({ title: 'Uncaught Exception', error });
});

// ── Graceful shutdown ──

let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
        // Destroy the Discord client connection
        client.destroy();
        logger.info('Discord client disconnected');
    } catch (err) {
        logger.error('Error disconnecting Discord client', { error: err.message });
    }

    try {
        // Close the database connection
        const db = getDb();
        db.close();
        logger.info('Database connection closed');
    } catch (err) {
        logger.error('Error closing database', { error: err.message });
    }

    logger.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Login
client.login(config.discordToken).catch((error) => {
    logger.error('Failed to login', { error: error.message });
    process.exit(1);
});
