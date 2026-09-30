/**
 * Natural-language tools for button role selectors.
 *
 * Available to members with Administrator, Manage Server, or Manage Roles
 * (the gate lives in adminTools.js#canUseAdminTool). Executed through
 * executeAdminTool so every call lands in the admin_tool_audit log.
 *
 * Every write tool goes through planRoleSelectorTool(), which resolves roles,
 * channels, and emojis and runs all safety checks without touching Discord or
 * the DB. The same plan powers three things:
 *   1. validateRoleSelectorTool — fail fast before the confirmation card, so
 *      Claude can correct a bad emoji / role instead of the admin confirming
 *      something that will fail
 *   2. buildRoleSelectorPreview — the live message preview on the card
 *   3. executeRoleSelectorTool — re-plans (state may have changed while the
 *      card was open) and applies
 */

import {
    buildSelectorMessage, normalizeEmoji, resolveRole, resolveTextChannel,
    parseMessageId, checkSelfAssignableRole, checkActorCanManageRole,
    checkBotCanPost, fetchSelectorMessage,
} from '../utils/roleSelectors.js';
import {
    MAX_SELECTOR_OPTIONS, createSelector, getSelector, getSelectorOptions,
    listSelectorsForGuild, replaceSelectorOptions, updateSelectorMeta, deleteSelector,
} from '../db/roleSelectors.js';
import logger from '../utils/logger.js';

const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_LABEL_LENGTH = 80;

const OPTION_SCHEMA = {
    type: 'object',
    properties: {
        role: { type: 'string', description: 'Role name exactly as it appears in the server, a role mention (<@&id>), or a role ID' },
        emoji: { type: 'string', description: 'One emoji for the button: a Unicode emoji character (e.g. "🎮") or a custom emoji in <:name:id> form. Never a :shortcode:. Optional.' },
        label: { type: 'string', description: 'Button text. Optional — defaults to the role name. Max 80 characters.' },
    },
    required: ['role'],
};

const MESSAGE_ID_PROPERTY = {
    type: 'string',
    description: 'The selector\'s message ID or message link. Omit ONLY if the server has exactly one role selector.',
};

export const ROLE_SELECTOR_TOOL_DEFINITIONS = [
    {
        name: 'create_role_selector',
        description: 'Post a permanent role selector message: one button per role. Members click a button to get the role and click again to remove it, and DiVA confirms privately to just them. Shows the admin a live preview before posting.',
        input_schema: {
            type: 'object',
            properties: {
                channel: { type: 'string', description: 'Channel to post in: name, <#id> mention, or ID. Omit to post in the current channel.' },
                title: { type: 'string', description: 'Heading for the selector, e.g. "Pick your games"' },
                description: { type: 'string', description: 'Optional instruction line shown above the role list' },
                exclusive: { type: 'boolean', description: 'true = members can hold only one role from this selector (picking another swaps it). Default false.' },
                options: { type: 'array', items: OPTION_SCHEMA, minItems: 1, maxItems: MAX_SELECTOR_OPTIONS, description: 'Roles in button order (max 25)' },
            },
            required: ['title', 'options'],
        },
    },
    {
        name: 'add_roles_to_selector',
        description: 'Add one or more role buttons to an existing role selector.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: MESSAGE_ID_PROPERTY,
                options: { type: 'array', items: OPTION_SCHEMA, minItems: 1, description: 'Roles to add, appended in order' },
            },
            required: ['options'],
        },
    },
    {
        name: 'remove_roles_from_selector',
        description: 'Remove role buttons from an existing role selector. Members who already have those roles keep them.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: MESSAGE_ID_PROPERTY,
                roles: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Role names, mentions, or IDs to remove' },
            },
            required: ['roles'],
        },
    },
    {
        name: 'edit_role_selector',
        description: 'Change an existing role selector\'s title, description, pick-one mode, or the emoji/label of roles already on it.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: MESSAGE_ID_PROPERTY,
                title: { type: 'string', description: 'New title (optional)' },
                description: { type: 'string', description: 'New description (optional). Pass an empty string to remove it.' },
                exclusive: { type: 'boolean', description: 'Turn pick-one mode on or off (optional)' },
                options: {
                    type: 'array',
                    items: OPTION_SCHEMA,
                    description: 'Emoji/label changes for roles ALREADY on the selector (optional). Pass emoji "" to remove an emoji.',
                },
            },
            required: [],
        },
    },
    {
        name: 'delete_role_selector',
        description: 'Delete a role selector message. Members keep any roles they already picked.',
        input_schema: {
            type: 'object',
            properties: { message_id: MESSAGE_ID_PROPERTY },
            required: [],
        },
    },
    {
        name: 'list_role_selectors',
        description: 'List every role selector in this server with its message ID, channel, and roles.',
        input_schema: { type: 'object', properties: {}, required: [] },
    },
];

export const ROLE_SELECTOR_TOOLS = new Set(ROLE_SELECTOR_TOOL_DEFINITIONS.map(t => t.name));
export const READ_ONLY_ROLE_SELECTOR_TOOLS = new Set(['list_role_selectors']);

// ── Planning (no side effects) ──

function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanDescription(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

async function getActor(guild, userId) {
    return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

function resolveSelector(guild, ref) {
    if (ref) {
        const messageId = parseMessageId(ref);
        if (!messageId) return { error: `"${ref}" isn't a message ID or message link.` };
        const selector = getSelector(messageId);
        if (!selector || selector.guildId !== guild.id) {
            return { error: `There's no role selector with message ID ${messageId} in this server. Call list_role_selectors to see them.` };
        }
        return { selector };
    }
    const all = listSelectorsForGuild(guild.id);
    if (all.length === 0) return { error: 'There are no role selectors in this server yet.' };
    if (all.length > 1) {
        return { error: `This server has ${all.length} role selectors — ask the admin which one (message ID or link), or call list_role_selectors.` };
    }
    return { selector: all[0] };
}

/**
 * Resolve and validate a list of role options for adding to a selector.
 * `taken` is the set of role IDs already on the selector.
 */
function resolveNewOptions(guild, actor, rawOptions, taken) {
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        return { error: 'Provide at least one role.' };
    }
    const seen = new Set(taken);
    const options = [];
    for (const raw of rawOptions) {
        const ref = raw?.role ?? raw?.role_name ?? raw?.name;
        const role = resolveRole(guild, ref);
        if (!role) return { error: `Role "${ref}" not found in this server.` };
        if (seen.has(role.id)) return { error: `**${role.name}** is already on this selector.` };
        const problem = checkSelfAssignableRole(role, guild) || checkActorCanManageRole(actor, role);
        if (problem) return { error: problem };
        const emoji = normalizeEmoji(raw.emoji, guild.client);
        if (!emoji.ok) return { error: emoji.error };
        options.push({
            roleId: role.id,
            emoji: emoji.value,
            label: cleanText(raw.label, MAX_LABEL_LENGTH) || role.name.slice(0, MAX_LABEL_LENGTH),
        });
        seen.add(role.id);
    }
    return { options };
}

/**
 * Work out exactly what a write tool would do. Returns { error } or a plan:
 *   { selector, options, channel? }  — the selector state AFTER the change
 */
export async function planRoleSelectorTool(toolName, input, guild, userId, context = {}) {
    const actor = await getActor(guild, userId);
    if (!actor) return { error: 'I couldn\'t find you in this server.' };

    if (toolName === 'create_role_selector') {
        const channel = input.channel
            ? resolveTextChannel(guild, input.channel)
            : guild.channels.cache.get(context.channelId);
        if (!channel) return { error: `Channel "${input.channel}" not found (it needs to be a text channel).` };
        const postProblem = checkBotCanPost(channel);
        if (postProblem) return { error: postProblem };

        const title = cleanText(input.title, MAX_TITLE_LENGTH);
        if (!title) return { error: 'The selector needs a title.' };
        if (input.options?.length > MAX_SELECTOR_OPTIONS) {
            return { error: `A selector can hold at most ${MAX_SELECTOR_OPTIONS} roles.` };
        }

        const resolved = resolveNewOptions(guild, actor, input.options, []);
        if (resolved.error) return resolved;
        return {
            channel,
            selector: { title, description: cleanDescription(input.description) || null, exclusive: !!input.exclusive },
            options: resolved.options,
        };
    }

    const { selector, error } = resolveSelector(guild, input.message_id);
    if (error) return { error };
    const current = getSelectorOptions(selector.messageId);

    if (toolName === 'add_roles_to_selector') {
        const resolved = resolveNewOptions(guild, actor, input.options, current.map(o => o.roleId));
        if (resolved.error) return resolved;
        const options = [...current, ...resolved.options];
        if (options.length > MAX_SELECTOR_OPTIONS) {
            return { error: `That would put ${options.length} roles on the selector — the max is ${MAX_SELECTOR_OPTIONS}.` };
        }
        return { selector, options };
    }

    if (toolName === 'remove_roles_from_selector') {
        const refs = Array.isArray(input.roles) ? input.roles : [];
        if (refs.length === 0) return { error: 'Name at least one role to remove.' };
        const removeIds = new Set();
        for (const ref of refs) {
            const role = resolveRole(guild, ref);
            if (!role) return { error: `Role "${ref}" not found in this server.` };
            if (!current.some(o => o.roleId === role.id)) return { error: `**${role.name}** isn't on this selector.` };
            const problem = checkActorCanManageRole(actor, role);
            if (problem) return { error: problem };
            removeIds.add(role.id);
        }
        const options = current.filter(o => !removeIds.has(o.roleId));
        if (options.length === 0) {
            return { error: 'That would remove every role. Use delete_role_selector to remove the whole selector instead.' };
        }
        return { selector, options };
    }

    if (toolName === 'edit_role_selector') {
        const next = { ...selector };
        let changed = false;
        if (input.title !== undefined) {
            next.title = cleanText(input.title, MAX_TITLE_LENGTH);
            if (!next.title) return { error: 'The title can\'t be empty.' };
            changed = true;
        }
        if (input.description !== undefined) {
            next.description = cleanDescription(input.description) || null;
            changed = true;
        }
        if (input.exclusive !== undefined) {
            next.exclusive = !!input.exclusive;
            changed = true;
        }

        const options = current.map(o => ({ ...o }));
        for (const raw of Array.isArray(input.options) ? input.options : []) {
            const ref = raw?.role ?? raw?.role_name ?? raw?.name;
            const role = resolveRole(guild, ref);
            const target = role && options.find(o => o.roleId === role.id);
            if (!target) return { error: `Role "${ref}" isn't on this selector. Use add_roles_to_selector to add it.` };
            if ('emoji' in raw) {
                const emoji = normalizeEmoji(raw.emoji, guild.client);
                if (!emoji.ok) return { error: emoji.error };
                target.emoji = emoji.value;
                changed = true;
            }
            if (raw.label !== undefined) {
                target.label = cleanText(raw.label, MAX_LABEL_LENGTH) || role.name.slice(0, MAX_LABEL_LENGTH);
                changed = true;
            }
        }
        if (!changed) return { error: 'Nothing to change — pass a title, description, exclusive, or option updates.' };
        return { selector: next, options };
    }

    if (toolName === 'delete_role_selector') {
        return { selector, options: current };
    }

    return { error: `Unknown role selector tool: ${toolName}` };
}

// ── Confirmation card hooks ──

/** Pre-flight check. Returns an error string, or null if the call looks valid. */
export async function validateRoleSelectorTool(toolName, input, guild, userId, context) {
    if (READ_ONLY_ROLE_SELECTOR_TOOLS.has(toolName)) return null;
    const plan = await planRoleSelectorTool(toolName, input, guild, userId, context);
    return plan.error || null;
}

/** The live message preview shown on the confirmation card. */
export async function buildRoleSelectorPreview(toolName, input, guild, userId, context) {
    if (READ_ONLY_ROLE_SELECTOR_TOOLS.has(toolName)) return null;
    const plan = await planRoleSelectorTool(toolName, input, guild, userId, context);
    if (plan.error) return null;
    const { embeds, components } = buildSelectorMessage(plan.selector, plan.options, { preview: true });
    return { embeds, components };
}

function selectorRef(input) {
    const id = parseMessageId(input?.message_id);
    return id ? `selector \`${id}\`` : 'the role selector';
}

function roleList(refs) {
    return (refs || []).map(r => `**${String(r?.role ?? r?.role_name ?? r).replace(/^@/, '')}**`).join(', ');
}

/** One-line description for the confirmation card. */
export function formatRoleSelectorToolForConfirmation(toolName, input) {
    switch (toolName) {
        case 'create_role_selector': {
            const where = input.channel ? `in ${input.channel.startsWith('<#') ? input.channel : `#${input.channel.replace(/^#/, '')}`}` : 'in this channel';
            const count = input.options?.length || 0;
            return `🎭 Post role selector **${input.title}** ${where} with ${count} role${count === 1 ? '' : 's'}${input.exclusive ? ' (pick one)' : ''} — preview below`;
        }
        case 'add_roles_to_selector':
            return `➕ Add ${roleList(input.options)} to ${selectorRef(input)} — preview below`;
        case 'remove_roles_from_selector':
            return `➖ Remove ${roleList(input.roles)} from ${selectorRef(input)} (members keep roles they already have) — preview below`;
        case 'edit_role_selector':
            return `✏️ Edit ${selectorRef(input)} — preview below`;
        case 'delete_role_selector':
            return `🗑️ Delete ${selectorRef(input)} shown below. Members keep roles they already picked.`;
        default:
            return `🔧 ${toolName}`;
    }
}

// ── Execution ──

function describeOptions(options) {
    return options.map(o => `${o.emoji ? `${o.emoji} ` : ''}${o.label}`).join(', ');
}

export async function executeRoleSelectorTool(toolName, input, guild, userId, context = {}) {
    if (toolName === 'list_role_selectors') {
        const selectors = listSelectorsForGuild(guild.id);
        if (selectors.length === 0) return { success: true, message: 'There are no role selectors in this server yet.' };
        const lines = selectors.map(s => {
            const options = getSelectorOptions(s.messageId);
            const url = `https://discord.com/channels/${guild.id}/${s.channelId}/${s.messageId}`;
            return `• **${s.title}** in <#${s.channelId}> — message ID \`${s.messageId}\`${s.exclusive ? ' (pick one)' : ''} — ${url}\n  Roles: ${describeOptions(options) || '(none)'}`;
        });
        return { success: true, message: lines.join('\n') };
    }

    const plan = await planRoleSelectorTool(toolName, input, guild, userId, context);
    if (plan.error) return { success: false, message: plan.error };

    if (toolName === 'create_role_selector') {
        const message = await plan.channel.send(buildSelectorMessage(plan.selector, plan.options));
        try {
            createSelector({
                messageId: message.id,
                guildId: guild.id,
                channelId: plan.channel.id,
                ...plan.selector,
                createdBy: userId,
            }, plan.options);
        } catch (err) {
            // Don't leave a live selector the DB doesn't know about — its buttons would be dead.
            await message.delete().catch(() => {});
            throw err;
        }
        logger.info('Role selector created', { guild: guild.id, user: userId, messageId: message.id, roles: plan.options.length });
        return {
            success: true,
            message: `Role selector "${plan.selector.title}" posted in <#${plan.channel.id}> with ${plan.options.length} role(s). Message ID ${message.id} — ${message.url}`,
            undo: { type: 'created_role_selector', messageId: message.id, channelId: plan.channel.id, title: plan.selector.title },
        };
    }

    // Everything else edits (or deletes) an existing live message.
    const { message, error } = await fetchSelectorMessage(guild.client, plan.selector);
    if (!message) return { success: false, message: error };

    if (toolName === 'delete_role_selector') {
        await message.delete();
        deleteSelector(plan.selector.messageId);
        logger.info('Role selector deleted', { guild: guild.id, user: userId, messageId: plan.selector.messageId });
        return { success: true, message: `Role selector "${plan.selector.title}" deleted. Members kept the roles they already had.` };
    }

    // Edit Discord first: if that fails, the DB is untouched and still matches the message.
    await message.edit(buildSelectorMessage(plan.selector, plan.options));
    if (toolName === 'edit_role_selector') {
        updateSelectorMeta(plan.selector.messageId, {
            title: plan.selector.title,
            description: plan.selector.description ?? '',
            exclusive: plan.selector.exclusive,
        });
    }
    replaceSelectorOptions(plan.selector.messageId, plan.options);

    logger.info('Role selector updated', { guild: guild.id, user: userId, tool: toolName, messageId: plan.selector.messageId });
    return {
        success: true,
        message: `Role selector "${plan.selector.title}" updated — it now has ${plan.options.length} role(s): ${describeOptions(plan.options)}. ${message.url}`,
    };
}

/** Undo for create_role_selector: delete the posted message and its rows. */
export async function undoCreatedRoleSelector(guild, action) {
    const selector = getSelector(action.messageId);
    if (selector) {
        const { message } = await fetchSelectorMessage(guild.client, selector);
        if (message) await message.delete();
        deleteSelector(action.messageId);
    }
    return { success: true, message: `Deleted role selector **${action.title}**.` };
}
