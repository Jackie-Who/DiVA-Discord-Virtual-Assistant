/**
 * /notices on  — enable update notices for this server (default state)
 * /notices off — disable update notices for this server
 *
 * Requires Manage Server. Default for new servers is ON (opt-OUT model). The
 * notices channel is set separately via /channel set notices #channel; if not
 * set, the update notifier falls back to the server's system channel.
 */

import { PermissionsBitField } from 'discord.js';
import { getGuildChannels, setNoticesEnabled } from '../db/guildChannels.js';
import logger from '../utils/logger.js';

export default async function notices(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Manage Server to toggle update notices.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'on') {
        setNoticesEnabled(guildId, true);
        const cfg = getGuildChannels(guildId);
        const where = cfg.noticesChannelId
            ? `<#${cfg.noticesChannelId}>`
            : interaction.guild.systemChannel
                ? `<#${interaction.guild.systemChannel.id}> _(default system channel — set a specific one with \`/channel set notices #channel\`)_`
                : '_(no usable channel — please run `/channel set notices #channel`)_';
        logger.info('Update notices enabled', { guildId, actor: interaction.user.id });
        return interaction.reply({
            content: `🔔 Update notices **enabled**. New version announcements will go to ${where}.`,
            ephemeral: true,
        });
    }

    if (sub === 'off') {
        setNoticesEnabled(guildId, false);
        logger.info('Update notices disabled', { guildId, actor: interaction.user.id });
        return interaction.reply({
            content: `🔕 Update notices **disabled**. You won't see version announcements until you re-enable with \`/notices on\`.`,
            ephemeral: true,
        });
    }

    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}
