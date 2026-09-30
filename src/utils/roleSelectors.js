/**
 * Button role selectors — rendering, safety checks, the click handler, and
 * housekeeping listeners.
 *
 * A selector is a DiVA-owned message with one button per role. Clicking a
 * button toggles that role on the member and replies ephemerally (only the
 * clicker sees it, with Discord's built-in "Dismiss message" link).
 *
 * Buttons use the custom ID `rolesel:<roleId>`. The message ID comes from the
 * interaction itself, so clicks survive bot restarts — the global router in
 * interactionCreate.js dispatches every `rolesel:` click here.
 *
 * Safety: a role can only be offered (and is re-checked on every click) if it
 * is not @everyone, not integration-managed, carries no moderator-level
 * permissions, and sits below DiVA's highest role.
 */

import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    GuildMember, PermissionFlagsBits, PermissionsBitField,
} from 'discord.js';
import {
    getSelector, getSelectorOption, getSelectorOptions, deleteSelector,
    getSelectorIdsForRole, replaceSelectorOptions,
} from '../db/roleSelectors.js';
import logger from './logger.js';

export const BUTTON_ID_PREFIX = 'rolesel:';
const PREVIEW_ID_PREFIX = 'rolesel_preview:';
const BUTTONS_PER_ROW = 5;
const MAX_LABEL_LENGTH = 80;
const EMBED_COLOR = 0x5865F2;

// Discord API error codes we treat as "that thing is gone for good".
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

// Permissions a self-assignable role must never carry — handing these out via
// a public button would let any member escalate themselves.
const ELEVATED_PERMISSIONS = [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
    'ManageWebhooks', 'ManageMessages', 'ManageNicknames', 'ManageGuildExpressions',
    'ManageEvents', 'ManageThreads', 'KickMembers', 'BanMembers', 'ModerateMembers',
    'MentionEveryone', 'ViewAuditLog', 'MuteMembers', 'DeafenMembers', 'MoveMembers',
];

// ── Rendering ──

/**
 * Build the message payload (embed + button rows) for a selector.
 * With `preview: true` the buttons are disabled and use non-routable IDs, so
 * the copy shown on a confirmation card can't be clicked.
 */
export function buildSelectorMessage(selector, options, { preview = false } = {}) {
    const lines = options.map(o => `${o.emoji ? `${o.emoji} ` : ''}<@&${o.roleId}>`);
    const parts = [];
    if (selector.description) parts.push(selector.description);
    parts.push(lines.length > 0 ? lines.join('\n') : '_No roles configured yet._');

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(selector.title)
        .setDescription(parts.join('\n\n'))
        .setFooter({
            text: selector.exclusive
                ? 'Pick one — choosing a new role replaces your old one. Click it again to remove it.'
                : 'Click a button to get the role · click it again to remove it',
        });

    const rows = [];
    for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
        const row = new ActionRowBuilder();
        for (const o of options.slice(i, i + BUTTONS_PER_ROW)) {
            const button = new ButtonBuilder()
                .setCustomId(`${preview ? PREVIEW_ID_PREFIX : BUTTON_ID_PREFIX}${o.roleId}`)
                .setLabel(o.label.slice(0, MAX_LABEL_LENGTH))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(preview);
            if (o.emoji) button.setEmoji(o.emoji);
            row.addComponents(button);
        }
        rows.push(row);
    }

    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

// ── Input parsing ──

const CUSTOM_EMOJI_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
const UNICODE_EMOJI_CHARS_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]+$/u;
const HAS_EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;

/**
 * Validate one emoji for use on a button. Returns { ok, value } or { ok: false, error }.
 * Accepts a Unicode emoji or a custom emoji (<:name:id>) the bot can see.
 */
export function normalizeEmoji(raw, client) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    const value = String(raw).trim();
    if (!value) return { ok: true, value: null };

    const custom = value.match(CUSTOM_EMOJI_RE);
    if (custom) {
        if (!client.emojis.cache.has(custom[3])) {
            return { ok: false, error: `I can't use the custom emoji ${value} — it has to come from a server I'm in.` };
        }
        return { ok: true, value };
    }
    if (/^:[\w+-]+:$/.test(value)) {
        return { ok: false, error: `"${value}" is a shortcode — pass the actual emoji character instead.` };
    }
    if (value.length <= 32 && UNICODE_EMOJI_CHARS_RE.test(value) && HAS_EMOJI_RE.test(value)) {
        return { ok: true, value };
    }
    return { ok: false, error: `"${value}" isn't a single emoji I can put on a button.` };
}

/** Resolve a role from a name, a <@&id> mention, or a raw ID. */
export function resolveRole(guild, ref) {
    if (!ref) return null;
    const text = String(ref).trim();
    const idMatch = text.match(/^<@&(\d{17,20})>$/) || text.match(/^(\d{17,20})$/);
    if (idMatch) return guild.roles.cache.get(idMatch[1]) || null;
    const name = text.replace(/^@/, '').toLowerCase();
    return guild.roles.cache.find(r => r.name.toLowerCase() === name) || null;
}

/** Resolve a text channel from a name (#name ok), a <#id> mention, or a raw ID. */
export function resolveTextChannel(guild, ref) {
    if (!ref) return null;
    const text = String(ref).trim();
    const idMatch = text.match(/^<#(\d{17,20})>$/) || text.match(/^(\d{17,20})$/);
    const channel = idMatch
        ? guild.channels.cache.get(idMatch[1])
        : guild.channels.cache.find(c => c.name.toLowerCase() === text.replace(/^#/, '').toLowerCase() && c.isTextBased());
    return channel && channel.isTextBased() && !channel.isVoiceBased() ? channel : null;
}

/** Pull a message ID out of a raw ID or a discord.com/channels/... link. */
export function parseMessageId(ref) {
    if (!ref) return null;
    const match = String(ref).trim().match(/(\d{17,20})\/?$/);
    return match ? match[1] : null;
}

// ── Safety checks ──

/**
 * Can this role be handed out by a public button? Returns null if yes, or a
 * human-readable reason if not. Checked when configuring AND on every click.
 */
export function checkSelfAssignableRole(role, guild) {
    if (role.id === guild.id) return 'The @everyone role can\'t be used in a role selector.';
    if (role.managed) return `**${role.name}** is managed by an integration (a bot, booster, or linked app), so it can't be self-assigned.`;
    const elevated = new PermissionsBitField(role.permissions).toArray()
        .filter(p => ELEVATED_PERMISSIONS.includes(p));
    if (elevated.length > 0) {
        return `**${role.name}** has moderator-level permissions (${elevated.join(', ')}), so it can't be self-assigned from a public button.`;
    }
    if (!role.editable) {
        return `I can't assign **${role.name}** — it's at or above my highest role (or I'm missing Manage Roles). Move my role above it in Server Settings → Roles.`;
    }
    return null;
}

/** Discord's hierarchy rule for the person configuring the selector. */
export function checkActorCanManageRole(member, role) {
    if (!member) return 'I couldn\'t find you in this server.';
    if (member.guild.ownerId === member.id) return null;
    if (member.roles.highest.comparePositionTo(role) > 0) return null;
    return `**${role.name}** is at or above your highest role, so you can't put it in a role selector.`;
}

/** Does the bot have what it needs to post a selector in this channel? */
export function checkBotCanPost(channel) {
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    const needed = [
        ['ViewChannel', PermissionFlagsBits.ViewChannel],
        ['SendMessages', PermissionFlagsBits.SendMessages],
        ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
    ];
    const missing = needed.filter(([, bit]) => !perms?.has(bit)).map(([name]) => name);
    return missing.length > 0 ? `I'm missing ${missing.join(', ')} in <#${channel.id}>.` : null;
}

// ── Live message sync ──

/**
 * Fetch a selector's live message. Cleans up the DB row if Discord says the
 * message or channel is gone for good. Returns { message } or { error, gone }.
 */
export async function fetchSelectorMessage(client, selector) {
    try {
        const channel = await client.channels.fetch(selector.channelId);
        const message = await channel.messages.fetch(selector.messageId);
        return { message };
    } catch (err) {
        if (err.code === UNKNOWN_MESSAGE || err.code === UNKNOWN_CHANNEL) {
            deleteSelector(selector.messageId);
            logger.info('Role selector message is gone — removed from DB', { messageId: selector.messageId });
            return { error: 'That role selector message no longer exists (it was deleted), so I removed it from my records.', gone: true };
        }
        return { error: `I couldn't reach that role selector message: ${err.message}`, gone: false };
    }
}

/** Re-render a selector's live message from the DB. */
export async function refreshSelectorMessage(client, messageId) {
    const selector = getSelector(messageId);
    if (!selector) return { ok: false, error: 'Role selector not found.' };
    const { message, error } = await fetchSelectorMessage(client, selector);
    if (!message) return { ok: false, error };
    await message.edit(buildSelectorMessage(selector, getSelectorOptions(messageId)));
    return { ok: true, url: message.url };
}

// ── Click handler ──

/**
 * Toggle the clicked role on the member and reply ephemerally.
 * Routed from interactionCreate.js for every `rolesel:` button.
 */
export async function handleRoleSelectorButton(interaction) {
    if (!interaction.inGuild()) return;
    await interaction.deferReply({ ephemeral: true });

    const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
    const roleId = interaction.customId.slice(BUTTON_ID_PREFIX.length);
    const messageId = interaction.message.id;

    const selector = getSelector(messageId);
    const option = selector ? getSelectorOption(messageId, roleId) : null;
    if (!option) return reply('This role option is no longer available.');

    const { guild } = interaction;
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return reply('That role no longer exists — ask a moderator to update this selector.');

    const problem = checkSelfAssignableRole(role, guild);
    if (problem) {
        logger.warn('Role selector click blocked by safety check', { guildId: guild.id, roleId, messageId, problem });
        return reply(`I can't hand out **${role.name}** right now — ask a moderator to check this selector.`);
    }

    const member = interaction.member instanceof GuildMember
        ? interaction.member
        : await guild.members.fetch(interaction.user.id);

    try {
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, 'Role selector');
            return reply(`➖ Removed <@&${roleId}>.`);
        }

        let swapped = [];
        if (selector.exclusive) {
            swapped = getSelectorOptions(messageId)
                .map(o => o.roleId)
                .filter(id => id !== roleId && member.roles.cache.has(id))
                .map(id => guild.roles.cache.get(id))
                .filter(r => r && r.editable);
            if (swapped.length > 0) await member.roles.remove(swapped, 'Role selector (pick one)');
        }
        await member.roles.add(roleId, 'Role selector');

        const swapNote = swapped.length > 0 ? ` (removed ${swapped.map(r => `<@&${r.id}>`).join(', ')})` : '';
        return reply(`✅ Added <@&${roleId}>${swapNote}.`);
    } catch (err) {
        logger.error('Role selector toggle failed', {
            guildId: guild.id, roleId, userId: interaction.user.id, error: err.message,
        });
        return reply('Something went wrong updating your roles. Try again in a moment.');
    }
}

// ── Housekeeping ──

/**
 * Keep the DB in step with Discord:
 *   - selector message deleted → drop its rows
 *   - role deleted → drop it from every selector and re-render those messages
 */
export function initRoleSelectorEvents(client) {
    const forget = (messageId) => {
        if (deleteSelector(messageId) > 0) {
            logger.info('Role selector message deleted — removed from DB', { messageId });
        }
    };

    client.on('messageDelete', (message) => forget(message.id));
    client.on('messageDeleteBulk', (messages) => messages.forEach((_, id) => forget(id)));

    client.on('roleDelete', async (role) => {
        for (const messageId of getSelectorIdsForRole(role.id)) {
            try {
                const remaining = getSelectorOptions(messageId).filter(o => o.roleId !== role.id);
                replaceSelectorOptions(messageId, remaining);
                await refreshSelectorMessage(client, messageId);
                logger.info('Pruned deleted role from role selector', { messageId, roleId: role.id });
            } catch (err) {
                logger.error('Failed to prune deleted role from selector', { messageId, roleId: role.id, error: err.message });
            }
        }
    });
}
