import { getGuildCreditUsage, getRecentSpend } from '../db/credits.js';

export default async function budget(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const usage = getGuildCreditUsage(guildId);

    // ~$0.005 average per exchange now that we route to Haiku for casual messages
    const avgCostPerExchange = 0.005;
    const estimatedRemaining = Math.floor(usage.remainingUsd / avgCostPerExchange);

    // Get last 7 days of spend for a small trend line
    const recentSpend = getRecentSpend(guildId, 7);
    const spentLast7Days = recentSpend.reduce((sum, day) => sum + day.cost_usd, 0);

    let color = 0x00cc66; // green
    if (usage.ownerManaged) color = 0x9b59b6;             // purple — special status
    else if (usage.remainingUsd <= 0) color = 0x808080;   // grey — out of credits
    else if (usage.remainingUsd < 2) color = 0xff0000;    // red
    else if (usage.remainingUsd < 5) color = 0xffaa00;    // orange

    const fields = [
        { name: 'Lifetime Granted', value: `$${usage.lifetimeCreditsUsd.toFixed(4)}`, inline: true },
        { name: 'Spent', value: `$${usage.totalSpentUsd.toFixed(4)}`, inline: true },
        { name: 'Remaining', value: `$${usage.remainingUsd.toFixed(4)}`, inline: true },
        { name: 'Last 7 Days', value: `$${spentLast7Days.toFixed(4)}`, inline: true },
        { name: 'Est. Exchanges Left', value: usage.ownerManaged ? '∞' : `~${estimatedRemaining}`, inline: true },
        { name: '​', value: '​', inline: true },
    ];

    let title = '💰 Server Credit Balance';
    let description = '';
    if (usage.ownerManaged) {
        description = '_This server is owner-managed — no credit limit applies._';
    } else if (usage.remainingUsd <= 0) {
        description = '⚠️ **Out of credits.** AI replies are paused. An admin can top up with `/credits`.';
    } else if (usage.lifetimeCreditsUsd > 0) {
        const pct = (usage.totalSpentUsd / usage.lifetimeCreditsUsd) * 100;
        if (pct >= 85) description = '⚠️ Saving mode is active (web search + image analysis disabled to stretch credits).';
    }

    const embed = {
        title,
        description: description || undefined,
        color,
        fields,
        footer: { text: 'Top up with /credits' },
    };

    await interaction.reply({ embeds: [embed], ephemeral: true });
}
