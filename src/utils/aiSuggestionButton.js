/**
 * AI-suggested reminder title button.
 *
 * After the bot creates a reminder, Haiku may suggest a polished title
 * (e.g. "groceries" → "Grocery Shopping"). If the suggestion differs from the
 * original, this module attaches a "✨ Use 'X'" button to the bot's reply.
 *
 * Click flow:
 *   1. Only the original message author can click (other users get an
 *      ephemeral "not yours" reply).
 *   2. On click, applyAiSuggestion() updates the reminder title in the DB.
 *   3. The button is disabled and the reply is edited to acknowledge the swap.
 *   4. The listener also auto-disables after 5 minutes.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { applyAiSuggestion } from '../ai/userTools.js';
import logger from './logger.js';

const LISTENER_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const MAX_BUTTONS_PER_ROW = 5; // Discord limit

/**
 * Attach AI-suggested title buttons to a reply message and listen for clicks.
 *
 * @param {Message} replyMsg  The bot's reply message
 * @param {Array}   suggestions  [{ reminderId, originalTitle, suggestedTitle }, ...]
 * @param {string}  authorUserId  Original message author — only they can click
 */
export async function attachAiSuggestionButtons(replyMsg, suggestions, authorUserId) {
    if (!replyMsg || suggestions.length === 0) return;

    // Build buttons — one per suggestion. Cap at 5 (Discord row limit).
    const limited = suggestions.slice(0, MAX_BUTTONS_PER_ROW);
    const buttonsByCustomId = new Map();
    const components = limited.map((s, i) => {
        const customId = `ai_swap_${replyMsg.id}_${s.reminderId}_${i}`;
        buttonsByCustomId.set(customId, s);
        return new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(truncateLabel(`Use "${s.suggestedTitle}"`))
            .setEmoji('✨')
            .setStyle(ButtonStyle.Primary);
    });

    const row = new ActionRowBuilder().addComponents(...components);

    // Edit the reply to attach the row(s)
    try {
        await replyMsg.edit({ components: [row] });
    } catch (err) {
        // Common cases: missing perms or original message was deleted. Skip silently.
        logger.warn('Failed to attach AI suggestion buttons', { error: err.message });
        return;
    }

    // Listen for clicks for 5 minutes
    const collector = replyMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: LISTENER_TIMEOUT_MS,
        filter: (i) => i.customId.startsWith(`ai_swap_${replyMsg.id}_`),
    });

    // Track which buttons have been handled so we can disable them per-click
    const handled = new Set();

    collector.on('collect', async (interaction) => {
        const suggestion = buttonsByCustomId.get(interaction.customId);
        if (!suggestion) {
            try { await interaction.reply({ content: 'That button is no longer active.', ephemeral: true }); } catch {}
            return;
        }

        // Only the original author may swap (per-user feature)
        if (interaction.user.id !== authorUserId) {
            try {
                await interaction.reply({
                    content: 'This is someone else\'s reminder — only they can swap the title.',
                    ephemeral: true,
                });
            } catch {}
            return;
        }

        if (handled.has(interaction.customId)) {
            try { await interaction.reply({ content: 'Already swapped — refresh /reminder list to see the new title.', ephemeral: true }); } catch {}
            return;
        }

        const result = await applyAiSuggestion(suggestion.reminderId, authorUserId, suggestion.suggestedTitle);
        if (!result.success) {
            try { await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true }); } catch {}
            return;
        }

        handled.add(interaction.customId);

        // Disable the clicked button (and any others on the row keep behavior intact),
        // and update the reply text to acknowledge the swap.
        try {
            const updatedRow = ActionRowBuilder.from(row).setComponents(
                row.components.map((c) => {
                    const cid = c.data?.custom_id ?? c.custom_id;
                    return ButtonBuilder.from(c).setDisabled(handled.has(cid) || cid === interaction.customId);
                })
            );
            await interaction.update({
                content: replyMsg.content + `\n\n✨ Title swapped to **"${result.message}"** for reminder #${suggestion.reminderId}.`,
                components: [updatedRow],
            });
            logger.info('AI suggestion applied', {
                userId: authorUserId,
                reminderId: suggestion.reminderId,
                from: suggestion.originalTitle,
                to: result.message,
            });
        } catch (err) {
            logger.error('Failed to update reply after AI swap', { error: err.message });
        }
    });

    collector.on('end', async () => {
        // After 5 minutes, disable all buttons to make it clear they're inert
        try {
            const disabledRow = ActionRowBuilder.from(row).setComponents(
                row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
            );
            await replyMsg.edit({ components: [disabledRow] });
        } catch {
            // Reply was deleted or edited — nothing to do
        }
    });
}

function truncateLabel(s, max = 80) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
