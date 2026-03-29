import { getCurrentMonthUsage } from '../db/tokenBudget.js';

export default async function budget(interaction) {
    const usage = getCurrentMonthUsage();

    const avgCostPerExchange = 0.0075;
    const estimatedRemaining = Math.floor(usage.remainingUsd / avgCostPerExchange);

    const embed = {
        title: '\u{1F4CA} Monthly API Budget',
        color: usage.remainingUsd < 2 ? 0xff0000 : usage.remainingUsd < 5 ? 0xffaa00 : 0x00cc66,
        fields: [
            { name: 'Input Tokens', value: usage.inputTokens.toLocaleString(), inline: true },
            { name: 'Output Tokens', value: usage.outputTokens.toLocaleString(), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Spent', value: `$${usage.costUsd.toFixed(4)}`, inline: true },
            { name: 'Budget', value: `$${usage.budgetLimitUsd.toFixed(2)}`, inline: true },
            { name: 'Remaining', value: `$${usage.remainingUsd.toFixed(4)}`, inline: true },
            { name: 'Est. Exchanges Left', value: `~${estimatedRemaining}`, inline: false },
        ],
        footer: { text: 'Resets on the 1st of each month' },
    };

    await interaction.reply({ embeds: [embed], ephemeral: true });
}
