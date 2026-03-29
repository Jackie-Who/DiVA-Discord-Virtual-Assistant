import dotenv from 'dotenv';
dotenv.config({ override: true });

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_IDS', 'ANTHROPIC_API_KEY'];

for (const key of required) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
        console.error('Copy .env.example to .env and fill in all required values.');
        process.exit(1);
    }
}

const config = Object.freeze({
    // Discord
    discordToken: process.env.DISCORD_TOKEN,
    discordClientId: process.env.DISCORD_CLIENT_ID,
    discordGuildIds: process.env.DISCORD_GUILD_IDS.split(',').map(id => id.trim()).filter(Boolean),

    // Anthropic
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,

    // Monitoring
    errorChannelId: process.env.ERROR_CHANNEL_ID || '',
    metricsChannelId: process.env.METRICS_CHANNEL_ID || '',
    notifyUserId: process.env.NOTIFY_USER_ID || '',

    // Budget
    monthlyTokenBudgetUsd: parseFloat(process.env.MONTHLY_TOKEN_BUDGET_USD) || 20,

    // Bot Tuning
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES) || 6,
    maxResponseTokens: parseInt(process.env.MAX_RESPONSE_TOKENS) || 512,
    personalityDigestInterval: parseInt(process.env.PERSONALITY_DIGEST_INTERVAL) || 15,

    // Rate Limiting
    rateLimitUserSeconds: parseInt(process.env.RATE_LIMIT_USER_SECONDS) || 5,
    rateLimitChannelCount: parseInt(process.env.RATE_LIMIT_CHANNEL_COUNT) || 5,
    rateLimitChannelSeconds: parseInt(process.env.RATE_LIMIT_CHANNEL_SECONDS) || 10,

    // Maintenance
    historyRetentionDays: parseInt(process.env.HISTORY_RETENTION_DAYS) || 14,

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
});

export default config;
