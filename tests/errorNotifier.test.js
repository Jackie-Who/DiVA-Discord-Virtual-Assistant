/**
 * Error Notifier Test
 *
 * Sends a real test error message to the private monitoring channel.
 * This verifies the Discord channel ID, user mention, and message format all work.
 *
 * Run: node tests/errorNotifier.test.js
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Client, GatewayIntentBits } from 'discord.js';
import { initErrorNotifier, notifyError } from '../src/utils/errorNotifier.js';

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    initErrorNotifier(client);

    // Test 1: Basic error notification
    console.log('Sending test error notification...');
    await notifyError({
        title: 'Test Error — Ignore This',
        error: new Error('This is a test error to verify the notification system works. If you see this, everything is wired up correctly.'),
        context: {
            guild: 'test-guild-id',
            channel: 'test-channel-id',
            user: 'test-user',
            trigger: 'manual test via node tests/errorNotifier.test.js',
        },
    });
    console.log('✅ Test error sent — check your private Discord channel.');

    // Test 2: Error with stack trace
    console.log('Sending test error with stack trace...');
    try {
        throw new TypeError('Simulated TypeError for stack trace testing');
    } catch (err) {
        await notifyError({
            title: 'Test Stack Trace — Ignore This',
            error: err,
            context: {
                guild: 'test-guild-id',
                note: 'Testing that stack traces render correctly in Discord',
            },
        });
    }
    console.log('✅ Stack trace error sent.');

    // Clean up
    client.destroy();
    console.log('\nAll test notifications sent. Check the monitoring channel.');
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('Failed to login:', err.message);
    process.exit(1);
});
