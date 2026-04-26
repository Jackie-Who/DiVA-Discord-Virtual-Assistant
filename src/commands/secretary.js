/**
 * /secretary on     — interactive setup wizard (delivery prefs + optional daily digest)
 * /secretary off    — disable the daily digest only (recurring reminders keep working)
 * /secretary status — show the user's current preferences
 * /secretary clear  — wipe all preferences (also stops recurring reminders that depend on them)
 *
 * Secretary mode is the user's "personal preferences" hub. It serves two purposes:
 *   1. Required setup for recurring reminders (delivery_mode + delivery_channel_id)
 *   2. Optional daily digest (secretary_enabled + secretary_time_local) on top
 *
 * The flag `secretary_enabled` controls ONLY the digest. Disabling the digest does
 * NOT clear the delivery preferences — recurring reminders keep firing as configured.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getUserSettings, setDeliveryPrefs, setSecretary, clearUserSettings } from '../db/userSettings.js';
import { isValidIANAZone } from '../utils/timezone.js';
import logger from '../utils/logger.js';

const WIZARD_TIMEOUT_MS = 120_000; // 2 minutes per step — generous

export default async function secretary(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') return runWizard(interaction);
    if (sub === 'off') return doOff(interaction);
    if (sub === 'status') return doStatus(interaction);
    if (sub === 'clear') return doClear(interaction);
    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

// ── /secretary on — interactive setup wizard ──

async function runWizard(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    }
    const userId = interaction.user.id;
    const settings = getUserSettings(userId);

    if (!settings.timezone) {
        return interaction.reply({
            content: 'Set your timezone first with `/timezone <zone>` (e.g., `/timezone America/Los_Angeles`), then run this again. You can also @mention me and say "set my timezone to vancouver" — I\'ll figure out the IANA name.',
            ephemeral: true,
        });
    }

    // Step 1 — delivery preference
    const deliveryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sec_dm').setLabel('DM').setEmoji('📬').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('sec_thisch').setLabel('This Channel').setEmoji('📢').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('sec_pickch').setLabel('Pick a Channel').setEmoji('📍').setStyle(ButtonStyle.Secondary),
    );

    const reply = await interaction.reply({
        content: '**Step 1 of 2 — Delivery preference**\nWhere should I send recurring reminders and (optionally) the daily digest?',
        components: [deliveryRow],
        ephemeral: true,
        fetchReply: true,
    });

    let deliveryClick;
    try {
        deliveryClick = await reply.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === userId && i.customId.startsWith('sec_'),
            time: WIZARD_TIMEOUT_MS,
        });
    } catch {
        return interaction.editReply({ content: '⏰ Timed out. Run `/secretary on` again to retry.', components: [] });
    }

    let deliveryMode, deliveryChannelId, deliveryDescription;
    if (deliveryClick.customId === 'sec_dm') {
        deliveryMode = 'dm';
        deliveryChannelId = null;
        deliveryDescription = 'Direct message';
        await deliveryClick.update({ content: '✅ DM selected. Loading next step...', components: [] });
    } else if (deliveryClick.customId === 'sec_thisch') {
        deliveryMode = 'channel';
        deliveryChannelId = interaction.channel.id;
        deliveryDescription = `<#${interaction.channel.id}>`;
        await deliveryClick.update({ content: `✅ This channel selected. Loading next step...`, components: [] });
    } else { // sec_pickch
        // Show a channel select menu
        const selectRow = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('sec_chsel')
                .setPlaceholder('Pick a channel')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1)
                .setMaxValues(1),
        );
        await deliveryClick.update({
            content: '**Step 1 of 2 — Pick a channel**',
            components: [selectRow],
        });

        let chSelect;
        try {
            chSelect = await reply.awaitMessageComponent({
                componentType: ComponentType.ChannelSelect,
                filter: (i) => i.user.id === userId && i.customId === 'sec_chsel',
                time: WIZARD_TIMEOUT_MS,
            });
        } catch {
            return interaction.editReply({ content: '⏰ Timed out. Run `/secretary on` again to retry.', components: [] });
        }
        const picked = chSelect.channels.first();
        deliveryMode = 'channel';
        deliveryChannelId = picked.id;
        deliveryDescription = `<#${picked.id}>`;
        await chSelect.update({ content: `✅ ${deliveryDescription} selected. Loading next step...`, components: [] });
    }

    // Save delivery prefs immediately so recurring reminders work even if user
    // bails on step 2.
    setDeliveryPrefs(userId, deliveryMode, deliveryChannelId);
    logger.info('Secretary delivery prefs saved', { userId, deliveryMode, deliveryChannelId });

    // Step 2 — daily digest opt-in
    const digestRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sec_digest_yes').setLabel('Yes — pick a time').setEmoji('🌅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('sec_digest_no').setLabel('Skip — just recurring').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
        content: `**Step 2 of 2 — Daily digest?**\nDelivery: **${deliveryDescription}**.\n\nThe daily digest is a once-a-day summary of your reminders for today + the next 48 hours, sent at a time you choose. Want it on?`,
        components: [digestRow],
    });

    let digestClick;
    try {
        digestClick = await reply.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === userId && i.customId.startsWith('sec_digest_'),
            time: WIZARD_TIMEOUT_MS,
        });
    } catch {
        return interaction.editReply({
            content: `✅ Delivery preferences saved (${deliveryDescription}). Daily digest skipped (timed out at step 2 — you can re-run \`/secretary on\` later).`,
            components: [],
        });
    }

    if (digestClick.customId === 'sec_digest_no') {
        setSecretary(userId, false, null);
        await digestClick.update({
            content: `✅ Setup complete.\n\n**Delivery:** ${deliveryDescription}\n**Daily digest:** off\n\nRecurring reminders ("every day at 8am", "every Monday at 9am") will work now. Set one with @mention.`,
            components: [],
        });
        return;
    }

    // Show modal asking for time
    const modal = new ModalBuilder()
        .setCustomId(`sec_time_modal_${interaction.id}`)
        .setTitle('Daily digest time');
    const timeInput = new TextInputBuilder()
        .setCustomId('sec_time_input')
        .setLabel('Time of day (24h format, HH:MM)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('08:00')
        .setRequired(true)
        .setMinLength(4)
        .setMaxLength(5)
        .setValue('08:00');
    modal.addComponents(new ActionRowBuilder().addComponents(timeInput));
    await digestClick.showModal(modal);

    let modalSubmit;
    try {
        modalSubmit = await digestClick.awaitModalSubmit({
            filter: (i) => i.user.id === userId && i.customId === `sec_time_modal_${interaction.id}`,
            time: WIZARD_TIMEOUT_MS,
        });
    } catch {
        return interaction.editReply({
            content: `✅ Delivery preferences saved (${deliveryDescription}). Daily digest skipped (timed out on time entry).`,
            components: [],
        });
    }

    const timeRaw = modalSubmit.fields.getTextInputValue('sec_time_input').trim();
    const time = normalizeHHMM(timeRaw);
    if (!time) {
        await modalSubmit.reply({ content: `❌ "${timeRaw}" isn't a valid time. Use HH:MM format like \`08:00\`. Run \`/secretary on\` again to retry.`, ephemeral: true });
        return;
    }

    setSecretary(userId, true, time);
    logger.info('Secretary digest enabled', { userId, time, deliveryMode, deliveryChannelId });

    await modalSubmit.reply({
        content: `🌅 **Setup complete!**\n\n**Delivery:** ${deliveryDescription}\n**Daily digest:** on at \`${time}\` (${settings.timezone})\n\nYou'll get your first digest tomorrow morning. Recurring reminders also work now.`,
        ephemeral: true,
    });
}

// ── /secretary off — disable the daily digest only ──

async function doOff(interaction) {
    const userId = interaction.user.id;
    const settings = getUserSettings(userId);
    if (!settings.secretaryEnabled) {
        return interaction.reply({ content: 'Daily digest is already off.', ephemeral: true });
    }
    setSecretary(userId, false, null);
    return interaction.reply({
        content: `🔕 Daily digest disabled. Your delivery preferences (${settings.deliveryMode === 'dm' ? 'DM' : `<#${settings.deliveryChannelId}>`}) are kept — recurring reminders will keep firing. Re-enable the digest anytime with \`/secretary on\`.`,
        ephemeral: true,
    });
}

// ── /secretary status ──

async function doStatus(interaction) {
    const settings = getUserSettings(interaction.user.id);
    const fields = [
        `**Timezone:** ${settings.timezone ? `\`${settings.timezone}\`` : '_(not set — run /timezone)_'}`,
    ];
    if (settings.deliveryMode === 'dm') {
        fields.push('**Delivery for recurring reminders:** Direct message');
    } else if (settings.deliveryMode === 'channel' && settings.deliveryChannelId) {
        fields.push(`**Delivery for recurring reminders:** <#${settings.deliveryChannelId}>`);
    } else {
        fields.push('**Delivery for recurring reminders:** _(not configured — run /secretary on to enable recurring)_');
    }
    if (settings.secretaryEnabled && settings.secretaryTimeLocal) {
        fields.push(`**Daily digest:** on at \`${settings.secretaryTimeLocal}\``);
    } else {
        fields.push('**Daily digest:** off');
    }
    return interaction.reply({
        embeds: [{
            title: '📋 Your Preferences',
            description: fields.join('\n'),
            color: 0x5865F2,
        }],
        ephemeral: true,
    });
}

// ── /secretary clear ──

async function doClear(interaction) {
    const userId = interaction.user.id;
    const settings = getUserSettings(userId);
    if (!settings.timezone && !settings.deliveryMode && !settings.secretaryEnabled) {
        return interaction.reply({ content: 'Nothing to clear — you have no preferences set.', ephemeral: true });
    }

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sec_clear_yes_${interaction.id}`).setLabel('Clear everything').setStyle(ButtonStyle.Danger).setEmoji('⚠️'),
        new ButtonBuilder().setCustomId(`sec_clear_no_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    const reply = await interaction.reply({
        content: 'Clear ALL your preferences? This will wipe your timezone, delivery preference, and digest setting. Recurring reminders that depend on these preferences will stop working until you reconfigure.',
        components: [confirmRow],
        ephemeral: true,
        fetchReply: true,
    });

    let click;
    try {
        click = await reply.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === userId,
            time: 30_000,
        });
    } catch {
        return interaction.editReply({ content: '⏰ Timed out — nothing changed.', components: [] });
    }

    if (click.customId === `sec_clear_no_${interaction.id}`) {
        return click.update({ content: 'Cancelled — nothing changed.', components: [] });
    }
    clearUserSettings(userId);
    logger.info('Secretary settings cleared', { userId });
    return click.update({ content: '🗑️ All preferences cleared.', components: [] });
}

// ── Helpers ──

/**
 * Accept loose user input ("8", "8am", "8:00", "08:00", "20:00", "8pm") and return
 * canonical "HH:MM" 24-hour, or null if unparseable.
 */
function normalizeHHMM(raw) {
    const s = raw.toLowerCase().trim();

    // Already canonical: "08:00" "20:30"
    let m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;

    // "8am", "8:30am", "8 am", "11:45 pm"
    m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s);
    if (m) {
        let hr = parseInt(m[1], 10);
        const min = m[2] ? parseInt(m[2], 10) : 0;
        if (hr < 1 || hr > 12 || min > 59) return null;
        if (m[3] === 'pm' && hr !== 12) hr += 12;
        if (m[3] === 'am' && hr === 12) hr = 0;
        return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    // Bare "8" or "08" → assume 8am-ish but reject (require explicit AM/PM or 24h)
    return null;
}

// Re-export helper test hook
export { normalizeHHMM, isValidIANAZone };
