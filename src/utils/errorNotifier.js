import logger from './logger.js';
import config from '../config.js';

let discordClient = null;

export function initErrorNotifier(client) {
    discordClient = client;
}

export async function notifyError({ title, error, context }) {
    if (!discordClient || !config.errorChannelId) return;

    try {
        const channel = await discordClient.channels.fetch(config.errorChannelId);
        if (!channel) return;

        const timestamp = new Date().toISOString();
        const contextStr = context
            ? Object.entries(context).map(([k, v]) => `**${k}:** ${v}`).join('\n')
            : 'No additional context';

        const errorMsg = [
            config.notifyUserId ? `<@${config.notifyUserId}>` : '',
            `### \u{1F6A8} ${title}`,
            `**Time:** ${timestamp}`,
            contextStr,
            '```',
            (error?.stack || error?.message || String(error)).slice(0, 1500),
            '```',
        ].join('\n');

        await channel.send(errorMsg.slice(0, 2000));
    } catch (sendError) {
        // Don't recurse — just log locally
        logger.error('Failed to send error notification', { error: sendError.message });
    }
}
