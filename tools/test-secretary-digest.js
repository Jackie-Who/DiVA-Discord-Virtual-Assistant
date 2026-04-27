/**
 * Dev tool: trigger your secretary digest immediately, regardless of the
 * configured digest time. Useful for previewing the digest format without
 * waiting until the next morning.
 *
 * Usage:
 *   node tools/test-secretary-digest.js                  → fires for the calling user (OWNER_USER_ID)
 *   node tools/test-secretary-digest.js <user_id>        → fires for a specific user
 *
 * Important:
 *   - Stop the running dev bot first — only one Discord session per token.
 *   - Sends the actual digest to the user's configured delivery target (DM or
 *     channel). The "already sent today" check is bypassed so you can run this
 *     multiple times to compare changes.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import config from '../src/config.js';
import { getDb } from '../src/db/init.js';
import logger from '../src/utils/logger.js';
import {
    sendDigestForUserNow,
} from '../src/utils/secretaryScheduler.js';

logger.setLevel('info');

if (config.isProd) {
    console.error('REFUSING to run in production. Set BOT_ENV=development.');
    process.exit(1);
}

getDb(); // ensure tables exist

const targetUserId = process.argv[2] || config.ownerUserId;
if (!targetUserId) {
    console.error('No user ID provided. Pass one as the first argument, or set OWNER_USER_ID in your .env.');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    console.log(`\n✅ Logged in as ${client.user.tag}`);
    console.log(`   Triggering secretary digest for user ${targetUserId}...\n`);

    try {
        const result = await sendDigestForUserNow(client, targetUserId);
        if (result.success) {
            console.log(`\n✅ Digest sent (${result.kind}, ${result.reminderCount} reminder${result.reminderCount === 1 ? '' : 's'}).`);
        } else {
            console.log(`\n⚠️  Digest skipped: ${result.reason}`);
        }
    } catch (err) {
        console.error('\n❌ Digest failed:', err.message);
        console.error(err.stack);
    }

    setTimeout(() => {
        client.destroy();
        process.exit(0);
    }, 2000);
});

client.on('error', (err) => console.error('Discord error:', err.message));
client.login(config.discordToken).catch((err) => {
    console.error('❌ Login failed:', err.message);
    console.error('   Hint: stop the running dev bot first.');
    process.exit(1);
});
