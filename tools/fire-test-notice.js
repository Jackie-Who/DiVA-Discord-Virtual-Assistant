/**
 * Dev tool: log in with the dev bot and fire an update notice immediately,
 * so you can preview what the announcement looks like before promoting to prod.
 *
 * Usage:
 *   node tools/fire-test-notice.js
 *
 * Important:
 *   - Stop the running dev bot first (`stop.bat` or kill the node process). This
 *     script logs in with the same DEV token, and Discord only allows one
 *     gateway session per token at a time.
 *   - Run with BOT_ENV=development (the default in your local .env). This script
 *     uses dryRun=true so it doesn't write last_announced_version, meaning the
 *     real bot can still announce the version normally on prod later.
 *   - The notice posts to each opted-in guild's configured notices_channel_id,
 *     falling back to the guild's system channel.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import config from '../src/config.js';
import { getDb } from '../src/db/init.js';
import { runUpdateNotifier } from '../src/utils/updateNotifier.js';
import logger from '../src/utils/logger.js';

logger.setLevel('info');

if (config.isProd) {
    console.error('REFUSING to run in production. This is a dev tool — set BOT_ENV=development.');
    process.exit(1);
}

// Make sure tables exist before the notifier touches them
getDb();

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', async () => {
    console.log(`\n✅ Logged in as ${client.user.tag} — firing test update notice...`);
    console.log(`   Guilds visible to dev bot: ${client.guilds.cache.size}`);
    console.log(`   Bot version (from src/version.js): see notifier output below\n`);

    try {
        await runUpdateNotifier(client, { force: true, dryRun: true });
        console.log('\n✅ Test notice complete. Check the test server\'s notices channel (or system channel if not configured).');
        console.log('   dryRun=true → last_announced_version was NOT written, so prod will still announce 1.2.0 cleanly.');
    } catch (err) {
        console.error('\n❌ Test notice failed:', err.message);
        console.error(err.stack);
    }

    setTimeout(() => {
        client.destroy();
        process.exit(0);
    }, 2000);
});

client.on('error', (err) => {
    console.error('Discord client error:', err.message);
});

client.login(config.discordToken).catch((err) => {
    console.error('❌ Failed to log in:', err.message);
    console.error('   Hint: stop the running dev bot first — only one session per token.');
    process.exit(1);
});
