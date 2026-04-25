import { getGuildCreditUsage, getRecentTransactions, topUp } from '../db/credits.js';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * /credits show — anyone can view the current balance + recent transactions.
 * /credits add <guild_id> <amount> [note] — owner only, adds credits to a guild.
 *
 * Phase 2 will hook a Stripe Checkout flow into a separate `/credits buy` subcommand.
 * For now, top-ups are owner-driven only.
 */
export default async function credits(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'show') {
        return showBalance(interaction);
    }
    if (sub === 'add') {
        return addCredits(interaction);
    }

    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

async function showBalance(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const usage = getGuildCreditUsage(guildId);
    const txns = getRecentTransactions(guildId, 5);

    let txnSection = '';
    if (txns.length > 0) {
        txnSection = '\n\n**Recent Transactions**\n' + txns.map(t => {
            const sign = (t.kind === 'topup' || t.kind === 'refund' || t.kind === 'migration') ? '+' : '';
            const amount = `${sign}$${t.amount_usd.toFixed(2)}`;
            const note = t.note ? ` — ${t.note}` : '';
            return `\`${t.created_at}\` **${t.kind}** ${amount}${note}`;
        }).join('\n');
    }

    let title = '💰 Server Credits';
    let body;
    if (usage.ownerManaged) {
        body = `_This server is owner-managed (no credit limit applies)._${txnSection}`;
    } else {
        body = [
            `**Lifetime Granted:** $${usage.lifetimeCreditsUsd.toFixed(4)}`,
            `**Spent:** $${usage.totalSpentUsd.toFixed(4)}`,
            `**Remaining:** $${usage.remainingUsd.toFixed(4)}`,
            '',
            usage.remainingUsd <= 0
                ? '⚠️ Out of credits — AI replies paused until topped up.'
                : '_Top-ups will be available via Stripe in a future update. For now, contact the bot owner to add credits._',
        ].join('\n') + txnSection;
    }

    await interaction.reply({
        embeds: [{
            title,
            description: body,
            color: usage.ownerManaged ? 0x9b59b6 : (usage.remainingUsd > 0 ? 0x00cc66 : 0x808080),
        }],
        ephemeral: true,
    });
}

async function addCredits(interaction) {
    // Owner-only gate
    if (!config.ownerUserId || interaction.user.id !== config.ownerUserId) {
        return interaction.reply({
            content: 'Only the bot owner can use `/credits add`.',
            ephemeral: true,
        });
    }

    const targetGuildId = interaction.options.getString('guild_id', true);
    const amount = interaction.options.getNumber('amount', true);
    const note = interaction.options.getString('note') || `Added by owner via /credits add`;

    if (!Number.isFinite(amount) || amount <= 0) {
        return interaction.reply({ content: 'Amount must be a positive number.', ephemeral: true });
    }

    try {
        const result = topUp(targetGuildId, amount, interaction.user.id, note);
        logger.info('Owner top-up via /credits add', {
            actor: interaction.user.id,
            targetGuildId,
            amount,
            note,
            newBalance: result.newBalance,
        });
        await interaction.reply({
            content: `✅ Added **$${amount.toFixed(2)}** to guild \`${targetGuildId}\`.\n` +
                     `New balance: **$${result.newBalance.toFixed(4)}** remaining ` +
                     `(of $${result.newLifetime.toFixed(4)} lifetime).`,
            ephemeral: true,
        });
    } catch (error) {
        logger.error('Top-up failed', { error: error.message, targetGuildId, amount });
        await interaction.reply({
            content: `❌ Top-up failed: ${error.message}`,
            ephemeral: true,
        });
    }
}
