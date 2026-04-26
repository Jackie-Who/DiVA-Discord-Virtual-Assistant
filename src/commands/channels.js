/**
 * /channel set <kind> #channel  — route a notification kind to a channel
 * /channel show                 — show the current routing
 *
 * Requires Manage Server. The kind is one of: error, metrics, notices.
 * Setting metrics also enables weekly_metrics_enabled. Notices stay enabled
 * by default for all servers (opt-OUT model).
 */

import { PermissionsBitField, ChannelType } from 'discord.js';
import {
    getGuildChannels,
    setErrorChannel,
    setMetricsChannel,
    setNoticesChannel,
} from '../db/guildChannels.js';
import logger from '../utils/logger.js';

export default async function channel(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
        !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Manage Server to configure channel routing.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'show') {
        const cfg = getGuildChannels(guildId);
        const fmt = (id) => id ? `<#${id}>` : '_(not set — uses fallback)_';
        const embed = {
            title: '📡 Channel Routing',
            color: 0x5865F2,
            fields: [
                { name: 'Errors', value: fmt(cfg.errorChannelId), inline: false },
                { name: 'Metrics', value: cfg.weeklyMetricsEnabled ? fmt(cfg.metricsChannelId) : '_(disabled)_', inline: false },
                { name: 'Update Notices', value: cfg.noticesEnabled ? fmt(cfg.noticesChannelId) : '_(disabled)_', inline: false },
            ],
            footer: { text: 'Set with /channel set <kind> #channel' },
        };
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'set') {
        const kind = interaction.options.getString('kind', true);
        const target = interaction.options.getChannel('channel', true);

        // Require a text-like channel (text, announcement, or thread)
        const allowedTypes = [
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
        ];
        if (!allowedTypes.includes(target.type)) {
            return interaction.reply({ content: 'That channel type isn\'t supported. Pick a text or announcement channel.', ephemeral: true });
        }

        switch (kind) {
            case 'error':
                setErrorChannel(guildId, target.id);
                break;
            case 'metrics':
                setMetricsChannel(guildId, target.id);
                break;
            case 'notices':
                setNoticesChannel(guildId, target.id);
                break;
            default:
                return interaction.reply({ content: `Unknown kind: ${kind}`, ephemeral: true });
        }

        logger.info('Channel routing updated', {
            guild: guildId,
            kind,
            channel: target.id,
            actor: interaction.user.id,
        });

        return interaction.reply({
            content: `✅ Routed **${kind}** notifications to <#${target.id}>.`,
            ephemeral: true,
        });
    }

    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}
