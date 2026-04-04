import { getPersonality, updatePersonality } from '../db/personality.js';
import { PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import logger from '../utils/logger.js';

export default async function personality(interaction) {
    // Admin-only check
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'This command is restricted to server administrators.', ephemeral: true });
    }

    const guildId = interaction.guild.id;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
        const prompt = getPersonality(guildId);
        if (!prompt) {
            return interaction.reply({
                content: 'No personality has evolved yet for this server. It develops automatically as the bot interacts with users.',
                ephemeral: true,
            });
        }
        return interaction.reply({
            content: `**Current personality for ${interaction.guild.name}:**\n\n> ${prompt.replace(/\n/g, '\n> ')}\n\n*This evolves automatically every 15 interactions.*`,
            ephemeral: true,
        });
    }

    if (subcommand === 'reset') {
        const prompt = getPersonality(guildId);
        if (!prompt) {
            return interaction.reply({ content: 'No personality to reset — none has evolved yet.', ephemeral: true });
        }

        const confirmId = `personality_reset_${interaction.id}`;
        const cancelId = `personality_cancel_${interaction.id}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel('Reset').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );

        const reply = await interaction.reply({
            content: `Are you sure you want to reset the personality? Current personality:\n\n> ${prompt.replace(/\n/g, '\n> ')}\n\nThis will be cleared and the bot will start evolving a new one from scratch.`,
            components: [row],
            ephemeral: true,
            fetchReply: true,
        });

        try {
            const btn = await reply.awaitMessageComponent({
                componentType: ComponentType.Button,
                filter: (i) => i.user.id === interaction.user.id,
                time: 30_000,
            });

            if (btn.customId === confirmId) {
                updatePersonality(guildId, '');
                logger.info('Personality reset', { guild: guildId, user: interaction.user.id });
                await btn.update({ content: 'Personality has been reset. A new one will evolve as the bot interacts with users.', components: [] });
            } else {
                await btn.update({ content: 'Reset cancelled.', components: [] });
            }
        } catch {
            try {
                await interaction.editReply({ content: 'Reset timed out — no changes made.', components: [] });
            } catch { /* already gone */ }
        }
    }
}
