import { ChannelType, PermissionFlagsBits, PermissionsBitField, ThreadAutoArchiveDuration, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import logger from '../utils/logger.js';
import { notifyError } from '../utils/errorNotifier.js';
import { checkAdminRateLimit, recordAdminToolCall } from '../utils/adminRateLimiter.js';

// ── Input sanitization ──

const MAX_NAME_LENGTH = 100;
const MAX_TOPIC_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 1000;
const CHANNEL_NAME_REGEX = /^[a-z0-9\-_]{1,100}$/;
const ROLE_NAME_REGEX = /^.{1,100}$/;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

function sanitizeString(str, maxLen) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}

function validateChannelName(name) {
    const cleaned = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').slice(0, 100);
    if (!cleaned) return { valid: false, error: 'Channel name is empty after cleaning invalid characters.' };
    return { valid: true, value: cleaned };
}

function validateName(name, label = 'Name') {
    const cleaned = sanitizeString(name, MAX_NAME_LENGTH);
    if (!cleaned) return { valid: false, error: `${label} cannot be empty.` };
    return { valid: true, value: cleaned };
}

function validateColor(color) {
    if (!color) return { valid: true, value: null };
    if (!HEX_COLOR_REGEX.test(color)) return { valid: false, error: `Invalid color "${color}". Use hex format like #ff5733.` };
    return { valid: true, value: color };
}

function validateTopic(topic) {
    if (!topic) return { valid: true, value: null };
    return { valid: true, value: sanitizeString(topic, MAX_TOPIC_LENGTH) };
}

// ── Admin permission re-check ──

function isStillAdmin(guild, userId) {
    const member = guild.members.cache.get(userId);
    if (!member) return false;
    return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

// ── Allowed tool names (server-side allowlist) ──

const ALLOWED_TOOLS = new Set([
    'create_text_channel', 'create_voice_channel', 'create_category',
    'create_announcement_channel', 'create_stage_channel', 'create_forum_channel',
    'edit_channel', 'move_channel', 'set_channel_permissions',
    'create_role', 'edit_role', 'assign_role', 'remove_role',
    'edit_server', 'create_thread', 'archive_thread', 'lock_thread',
    'create_emoji', 'rename_emoji', 'create_scheduled_event',
    'set_nickname', 'list_channels', 'list_roles',
]);

// ── Permission flag name map (for natural language → PermissionFlagsBits) ──
const PERMISSION_MAP = {
    'viewchannel': PermissionFlagsBits.ViewChannel,
    'sendmessages': PermissionFlagsBits.SendMessages,
    'sendmessagesinthreads': PermissionFlagsBits.SendMessagesInThreads,
    'createpublicthreads': PermissionFlagsBits.CreatePublicThreads,
    'createprivatethreads': PermissionFlagsBits.CreatePrivateThreads,
    'embedlinks': PermissionFlagsBits.EmbedLinks,
    'attachfiles': PermissionFlagsBits.AttachFiles,
    'addreactions': PermissionFlagsBits.AddReactions,
    'useexternalemojis': PermissionFlagsBits.UseExternalEmojis,
    'useexternalstickers': PermissionFlagsBits.UseExternalStickers,
    'mentioneveryone': PermissionFlagsBits.MentionEveryone,
    'managemessages': PermissionFlagsBits.ManageMessages,
    'managethreads': PermissionFlagsBits.ManageThreads,
    'readmessagehistory': PermissionFlagsBits.ReadMessageHistory,
    'sendttsmessages': PermissionFlagsBits.SendTTSMessages,
    'useslashcommands': PermissionFlagsBits.UseApplicationCommands,
    'connect': PermissionFlagsBits.Connect,
    'speak': PermissionFlagsBits.Speak,
    'stream': PermissionFlagsBits.Stream,
    'usevad': PermissionFlagsBits.UseVAD,
    'priorityspeaker': PermissionFlagsBits.PrioritySpeaker,
    'mutemembers': PermissionFlagsBits.MuteMembers,
    'deafenmembers': PermissionFlagsBits.DeafenMembers,
    'movemembers': PermissionFlagsBits.MoveMembers,
    'managechannels': PermissionFlagsBits.ManageChannels,
    'manageroles': PermissionFlagsBits.ManageRoles,
    'manageguild': PermissionFlagsBits.ManageGuild,
    'managewebhooks': PermissionFlagsBits.ManageWebhooks,
    'manageemojisandstickers': PermissionFlagsBits.ManageEmojisAndStickers,
    'manageevents': PermissionFlagsBits.ManageEvents,
    'managenicknames': PermissionFlagsBits.ManageNicknames,
    'changenickname': PermissionFlagsBits.ChangeNickname,
    'administrator': PermissionFlagsBits.Administrator,
};

function resolvePermissions(names) {
    if (!names || !Array.isArray(names)) return [];
    return names
        .map(n => PERMISSION_MAP[n.toLowerCase().replace(/[\s_]/g, '')])
        .filter(Boolean);
}

// ── Tool definitions sent to the Anthropic API ──

export const ADMIN_TOOL_DEFINITIONS = [

    // ═══════════════ CHANNEL MANAGEMENT ═══════════════

    {
        name: 'create_text_channel',
        description: 'Create a new text channel. Optionally place under a category and set topic/slowmode/NSFW.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Channel name (lowercase, hyphens instead of spaces)' },
                category: { type: 'string', description: 'Name of existing category to place it under (optional)' },
                topic: { type: 'string', description: 'Channel topic/description (optional)' },
                slowmode: { type: 'integer', description: 'Slowmode in seconds, 0-21600 (optional)' },
                nsfw: { type: 'boolean', description: 'Mark as NSFW (optional, default false)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_voice_channel',
        description: 'Create a new voice channel. Optionally set user limit and bitrate.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Voice channel name' },
                category: { type: 'string', description: 'Name of existing category (optional)' },
                user_limit: { type: 'integer', description: 'Max users, 0 = unlimited (optional)' },
                bitrate: { type: 'integer', description: 'Audio bitrate in bps, 8000-384000 (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_category',
        description: 'Create a new channel category.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Category name' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_announcement_channel',
        description: 'Create a new announcement/news channel.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Channel name' },
                category: { type: 'string', description: 'Name of existing category (optional)' },
                topic: { type: 'string', description: 'Channel topic (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_stage_channel',
        description: 'Create a new stage channel for live audio events.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Stage channel name' },
                category: { type: 'string', description: 'Name of existing category (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_forum_channel',
        description: 'Create a new forum channel where users can create discussion posts.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Forum channel name' },
                category: { type: 'string', description: 'Name of existing category (optional)' },
                topic: { type: 'string', description: 'Forum guidelines/description (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'edit_channel',
        description: 'Edit an existing channel\'s properties: name, topic, slowmode, NSFW, user limit, bitrate.',
        input_schema: {
            type: 'object',
            properties: {
                channel_name: { type: 'string', description: 'Current name of the channel to edit' },
                new_name: { type: 'string', description: 'New name (optional)' },
                topic: { type: 'string', description: 'New topic/description (optional, text channels only)' },
                slowmode: { type: 'integer', description: 'Slowmode in seconds (optional, 0 to disable)' },
                nsfw: { type: 'boolean', description: 'NSFW flag (optional)' },
                user_limit: { type: 'integer', description: 'User limit for voice channels (optional)' },
                bitrate: { type: 'integer', description: 'Bitrate for voice channels (optional)' },
            },
            required: ['channel_name'],
        },
    },
    {
        name: 'move_channel',
        description: 'Move a channel into a different category, or out of any category.',
        input_schema: {
            type: 'object',
            properties: {
                channel_name: { type: 'string', description: 'Name of the channel to move' },
                category_name: { type: 'string', description: 'Name of the target category. Use "none" to remove from any category.' },
            },
            required: ['channel_name', 'category_name'],
        },
    },
    {
        name: 'set_channel_permissions',
        description: 'Set permission overwrites for a specific role or user on a channel. This allows or denies specific permissions for that role/user in that channel.',
        input_schema: {
            type: 'object',
            properties: {
                channel_name: { type: 'string', description: 'Name of the channel' },
                target_name: { type: 'string', description: 'Name of the role or username to set permissions for' },
                target_type: { type: 'string', enum: ['role', 'user'], description: 'Whether the target is a role or user' },
                allow: {
                    type: 'array', items: { type: 'string' },
                    description: 'Permissions to allow. Options: ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak, Stream, AddReactions, AttachFiles, EmbedLinks, ManageMessages, ManageChannels, MentionEveryone, UseExternalEmojis, ManageRoles, ManageThreads, CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, MoveMembers, MuteMembers, DeafenMembers, PrioritySpeaker',
                },
                deny: {
                    type: 'array', items: { type: 'string' },
                    description: 'Permissions to deny. Same options as allow.',
                },
            },
            required: ['channel_name', 'target_name', 'target_type'],
        },
    },

    // ═══════════════ ROLE MANAGEMENT ═══════════════

    {
        name: 'create_role',
        description: 'Create a new role with optional color, hoist, mentionable, and permissions.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Role name' },
                color: { type: 'string', description: 'Hex color code e.g. #ff5733 (optional)' },
                hoist: { type: 'boolean', description: 'Display role members separately in the sidebar (optional)' },
                mentionable: { type: 'boolean', description: 'Allow anyone to @mention this role (optional)' },
                permissions: {
                    type: 'array', items: { type: 'string' },
                    description: 'Permissions to grant. Options: ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak, Stream, AddReactions, AttachFiles, EmbedLinks, ManageMessages, ManageChannels, MentionEveryone, ManageRoles, ManageNicknames, ChangeNickname, ManageEmojisAndStickers, ManageEvents, ManageWebhooks, ManageThreads, ManageGuild',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'edit_role',
        description: 'Edit an existing role\'s name, color, hoist, mentionable, or permissions.',
        input_schema: {
            type: 'object',
            properties: {
                role_name: { type: 'string', description: 'Current name of the role to edit' },
                new_name: { type: 'string', description: 'New name (optional)' },
                color: { type: 'string', description: 'New hex color code (optional)' },
                hoist: { type: 'boolean', description: 'Display separately in sidebar (optional)' },
                mentionable: { type: 'boolean', description: 'Allow @mentions (optional)' },
                permissions: {
                    type: 'array', items: { type: 'string' },
                    description: 'New permissions list — replaces existing permissions (optional)',
                },
            },
            required: ['role_name'],
        },
    },
    {
        name: 'assign_role',
        description: 'Assign one or more roles to a server member.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Username or display name of the member' },
                role_names: {
                    type: 'array', items: { type: 'string' },
                    description: 'Names of roles to assign',
                },
            },
            required: ['username', 'role_names'],
        },
    },
    {
        name: 'remove_role',
        description: 'Remove one or more roles from a server member.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Username or display name of the member' },
                role_names: {
                    type: 'array', items: { type: 'string' },
                    description: 'Names of roles to remove',
                },
            },
            required: ['username', 'role_names'],
        },
    },

    // ═══════════════ SERVER SETTINGS ═══════════════

    {
        name: 'edit_server',
        description: 'Edit server settings: name, description, AFK channel/timeout, system channel, notification level, verification level.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'New server name (optional)' },
                description: { type: 'string', description: 'New server description (optional, community servers only)' },
                afk_channel: { type: 'string', description: 'Name of voice channel to use as AFK channel (optional)' },
                afk_timeout: { type: 'integer', enum: [60, 300, 900, 1800, 3600], description: 'AFK timeout in seconds (optional)' },
                system_channel: { type: 'string', description: 'Name of channel for system messages like join notifications (optional)' },
                default_notifications: { type: 'string', enum: ['all_messages', 'only_mentions'], description: 'Default notification level (optional)' },
            },
            required: [],
        },
    },

    // ═══════════════ THREAD MANAGEMENT ═══════════════

    {
        name: 'create_thread',
        description: 'Create a new thread in a text channel.',
        input_schema: {
            type: 'object',
            properties: {
                channel_name: { type: 'string', description: 'Name of the text channel to create the thread in' },
                name: { type: 'string', description: 'Thread name' },
                private: { type: 'boolean', description: 'Make it a private thread (optional, default false)' },
                auto_archive_minutes: { type: 'integer', enum: [60, 1440, 4320, 10080], description: 'Auto-archive after N minutes of inactivity: 60, 1440 (1 day), 4320 (3 days), 10080 (7 days). Optional.' },
            },
            required: ['channel_name', 'name'],
        },
    },
    {
        name: 'archive_thread',
        description: 'Archive or unarchive a thread.',
        input_schema: {
            type: 'object',
            properties: {
                thread_name: { type: 'string', description: 'Name of the thread' },
                archived: { type: 'boolean', description: 'true to archive, false to unarchive' },
            },
            required: ['thread_name', 'archived'],
        },
    },
    {
        name: 'lock_thread',
        description: 'Lock or unlock a thread (only moderators can send messages in locked threads).',
        input_schema: {
            type: 'object',
            properties: {
                thread_name: { type: 'string', description: 'Name of the thread' },
                locked: { type: 'boolean', description: 'true to lock, false to unlock' },
            },
            required: ['thread_name', 'locked'],
        },
    },

    // ═══════════════ EMOJI MANAGEMENT ═══════════════

    {
        name: 'create_emoji',
        description: 'Create a custom server emoji from an image URL.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Emoji name (alphanumeric and underscores only)' },
                image_url: { type: 'string', description: 'URL of the image to use (PNG, JPG, or GIF, max 256KB)' },
            },
            required: ['name', 'image_url'],
        },
    },
    {
        name: 'rename_emoji',
        description: 'Rename an existing custom emoji.',
        input_schema: {
            type: 'object',
            properties: {
                current_name: { type: 'string', description: 'Current emoji name' },
                new_name: { type: 'string', description: 'New emoji name' },
            },
            required: ['current_name', 'new_name'],
        },
    },

    // ═══════════════ SCHEDULED EVENTS ═══════════════

    {
        name: 'create_scheduled_event',
        description: 'Create a scheduled server event (voice channel event, stage event, or external location event).',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Event name' },
                description: { type: 'string', description: 'Event description (optional)' },
                start_time: { type: 'string', description: 'Start time in ISO 8601 format, e.g. 2026-04-01T18:00:00Z' },
                end_time: { type: 'string', description: 'End time in ISO 8601 (required for external events, optional otherwise)' },
                type: { type: 'string', enum: ['voice', 'stage', 'external'], description: 'Event type' },
                channel_name: { type: 'string', description: 'Voice/stage channel name (required for voice/stage events)' },
                location: { type: 'string', description: 'Location string (required for external events)' },
            },
            required: ['name', 'start_time', 'type'],
        },
    },

    // ═══════════════ MEMBER MANAGEMENT ═══════════════

    {
        name: 'set_nickname',
        description: 'Set or clear a member\'s server nickname.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Username or display name of the member' },
                nickname: { type: 'string', description: 'New nickname, or empty string to clear' },
            },
            required: ['username', 'nickname'],
        },
    },

    // ═══════════════ INFO / LISTING ═══════════════

    {
        name: 'list_channels',
        description: 'List all channels in the server, organized by category.',
        input_schema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'list_roles',
        description: 'List all roles in the server with their colors and member counts.',
        input_schema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
];

// ── Read-only tools that don't need confirmation ──

const READ_ONLY_TOOLS = new Set(['list_channels', 'list_roles']);

/**
 * Check if a tool is read-only (info/listing only, no server changes).
 */
export function isReadOnlyTool(toolName) {
    return READ_ONLY_TOOLS.has(toolName);
}

/**
 * Format a tool call into a human-readable description for confirmation.
 */
export function formatToolForConfirmation(toolName, input) {
    switch (toolName) {
        case 'create_text_channel':
            return `📝 Create text channel **#${input.name}**${input.category ? ` under "${input.category}"` : ''}${input.topic ? ` — topic: "${input.topic}"` : ''}`;
        case 'create_voice_channel':
            return `🔊 Create voice channel **${input.name}**${input.category ? ` under "${input.category}"` : ''}${input.user_limit ? ` (max ${input.user_limit} users)` : ''}`;
        case 'create_category':
            return `📁 Create category **${input.name}**`;
        case 'create_announcement_channel':
            return `📢 Create announcement channel **#${input.name}**${input.category ? ` under "${input.category}"` : ''}`;
        case 'create_stage_channel':
            return `🎭 Create stage channel **${input.name}**${input.category ? ` under "${input.category}"` : ''}`;
        case 'create_forum_channel':
            return `💬 Create forum channel **#${input.name}**${input.category ? ` under "${input.category}"` : ''}`;
        case 'edit_channel':
            return `✏️ Edit channel **#${input.channel_name}**${input.new_name ? ` → rename to "${input.new_name}"` : ''}${input.topic ? ` — set topic: "${input.topic}"` : ''}${input.slowmode !== undefined ? ` — slowmode: ${input.slowmode}s` : ''}${input.nsfw !== undefined ? ` — NSFW: ${input.nsfw}` : ''}`;
        case 'move_channel':
            return `↕️ Move channel **#${input.channel_name}** → ${input.category_name === 'none' ? 'no category' : `category "${input.category_name}"`}`;
        case 'set_channel_permissions': {
            const allows = input.allow?.length ? `allow: ${input.allow.join(', ')}` : '';
            const denies = input.deny?.length ? `deny: ${input.deny.join(', ')}` : '';
            return `🔒 Set permissions on **#${input.channel_name}** for ${input.target_type} "${input.target_name}" — ${[allows, denies].filter(Boolean).join('; ')}`;
        }
        case 'create_role':
            return `🏷️ Create role **${input.name}**${input.color ? ` (${input.color})` : ''}${input.hoist ? ' — displayed separately' : ''}`;
        case 'edit_role':
            return `✏️ Edit role **${input.role_name}**${input.new_name ? ` → rename to "${input.new_name}"` : ''}${input.color ? ` — color: ${input.color}` : ''}`;
        case 'assign_role':
            return `➕ Assign role(s) **${input.role_names?.join(', ')}** to **${input.username}**`;
        case 'remove_role':
            return `➖ Remove role(s) **${input.role_names?.join(', ')}** from **${input.username}**`;
        case 'edit_server':
            return `⚙️ Edit server settings${input.name ? ` — name: "${input.name}"` : ''}${input.description ? ` — description updated` : ''}${input.afk_timeout ? ` — AFK timeout: ${input.afk_timeout}s` : ''}${input.default_notifications ? ` — notifications: ${input.default_notifications}` : ''}`;
        case 'create_thread':
            return `🧵 Create${input.private ? ' private' : ''} thread **${input.name}** in **#${input.channel_name}**`;
        case 'archive_thread':
            return `📦 ${input.archived ? 'Archive' : 'Unarchive'} thread **${input.thread_name}**`;
        case 'lock_thread':
            return `🔐 ${input.locked ? 'Lock' : 'Unlock'} thread **${input.thread_name}**`;
        case 'create_emoji':
            return `😀 Create emoji **:${input.name}:** from URL`;
        case 'rename_emoji':
            return `✏️ Rename emoji **:${input.current_name}:** → **:${input.new_name}:**`;
        case 'create_scheduled_event':
            return `📅 Create ${input.type} event **${input.name}** starting ${input.start_time}${input.location ? ` at "${input.location}"` : ''}`;
        case 'set_nickname':
            return `👤 Set nickname for **${input.username}** → ${input.nickname ? `"${input.nickname}"` : '(clear)'}`;
        default:
            return `🔧 Execute **${toolName}** with input: ${JSON.stringify(input).slice(0, 150)}`;
    }
}

// ── Helper functions ──

function findCategory(guild, name) {
    return guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()
    );
}

function findChannel(guild, name) {
    return guild.channels.cache.find(
        c => c.name.toLowerCase() === name.toLowerCase() && c.type !== ChannelType.GuildCategory
    );
}

function findChannelAny(guild, name) {
    return guild.channels.cache.find(
        c => c.name.toLowerCase() === name.toLowerCase()
    );
}

function findRole(guild, name) {
    return guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
}

async function findMember(guild, name) {
    // Try by display name, then username
    let member = guild.members.cache.find(
        m => m.displayName.toLowerCase() === name.toLowerCase() ||
             m.user.username.toLowerCase() === name.toLowerCase()
    );
    if (!member) {
        // Fetch from API
        const fetched = await guild.members.fetch({ query: name, limit: 1 });
        member = fetched.first();
    }
    return member;
}

function findThread(guild, name) {
    return guild.channels.cache.find(
        c => c.isThread() && c.name.toLowerCase() === name.toLowerCase()
    );
}

// ── Tool executor ──

export async function executeAdminTool(toolName, input, guild, userId) {
    // ── Server-side allowlist check ──
    if (!ALLOWED_TOOLS.has(toolName)) {
        await notifyError({
            title: 'Unknown tool attempted',
            error: new Error(`Tool "${toolName}" is not in the allowlist`),
            context: { guild: guild.id, user: userId, tool: toolName },
        });
        return { success: false, message: 'That action is not available.' };
    }

    // ── Re-verify admin permissions before every tool execution ──
    if (!isStillAdmin(guild, userId)) {
        await notifyError({
            title: 'Admin permission lost during tool chain',
            error: new Error('User no longer has admin permissions'),
            context: { guild: guild.id, user: userId, tool: toolName },
        });
        return { success: false, message: 'You no longer have admin permissions to perform this action.' };
    }

    // ── Per-guild rate limiting on admin tools ──
    const rateCheck = checkAdminRateLimit(guild.id);
    if (!rateCheck.allowed) {
        const retrySeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
        return { success: false, message: `Too many admin actions in a short time. Try again in ${retrySeconds} seconds.` };
    }
    recordAdminToolCall(guild.id);

    try {
        switch (toolName) {

            // ── Channel Creation ──

            case 'create_text_channel': {
                const v = validateChannelName(input.name);
                if (!v.valid) return { success: false, message: v.error };
                const topic = validateTopic(input.topic);
                const parent = input.category ? findCategory(guild, sanitizeString(input.category, MAX_NAME_LENGTH)) : null;
                const opts = {
                    name: v.value,
                    type: ChannelType.GuildText,
                    parent: parent?.id || null,
                };
                if (topic.value) opts.topic = topic.value;
                if (input.slowmode != null) opts.rateLimitPerUser = Math.max(0, Math.min(21600, input.slowmode));
                if (input.nsfw != null) opts.nsfw = !!input.nsfw;
                const ch = await guild.channels.create(opts);
                logger.info('Admin tool: text channel created', { guild: guild.id, user: userId, channel: ch.name });
                return { success: true, message: `Text channel #${ch.name} created${parent ? ` under ${parent.name}` : ''}.` };
            }

            case 'create_voice_channel': {
                const v = validateName(input.name, 'Channel name');
                if (!v.valid) return { success: false, message: v.error };
                const parent = input.category ? findCategory(guild, sanitizeString(input.category, MAX_NAME_LENGTH)) : null;
                const opts = {
                    name: v.value,
                    type: ChannelType.GuildVoice,
                    parent: parent?.id || null,
                };
                if (input.user_limit != null) opts.userLimit = Math.max(0, Math.min(99, input.user_limit));
                if (input.bitrate != null) opts.bitrate = Math.max(8000, Math.min(384000, input.bitrate));
                const ch = await guild.channels.create(opts);
                logger.info('Admin tool: voice channel created', { guild: guild.id, user: userId, channel: ch.name });
                return { success: true, message: `Voice channel "${ch.name}" created${parent ? ` under ${parent.name}` : ''}.` };
            }

            case 'create_category': {
                const v = validateName(input.name, 'Category name');
                if (!v.valid) return { success: false, message: v.error };
                const cat = await guild.channels.create({ name: v.value, type: ChannelType.GuildCategory });
                logger.info('Admin tool: category created', { guild: guild.id, user: userId, category: cat.name });
                return { success: true, message: `Category "${cat.name}" created.` };
            }

            case 'create_announcement_channel': {
                const v = validateChannelName(input.name);
                if (!v.valid) return { success: false, message: v.error };
                const topic = validateTopic(input.topic);
                const parent = input.category ? findCategory(guild, sanitizeString(input.category, MAX_NAME_LENGTH)) : null;
                const opts = {
                    name: v.value,
                    type: ChannelType.GuildAnnouncement,
                    parent: parent?.id || null,
                };
                if (topic.value) opts.topic = topic.value;
                const ch = await guild.channels.create(opts);
                logger.info('Admin tool: announcement channel created', { guild: guild.id, user: userId, channel: ch.name });
                return { success: true, message: `Announcement channel #${ch.name} created.` };
            }

            case 'create_stage_channel': {
                const v = validateName(input.name, 'Stage channel name');
                if (!v.valid) return { success: false, message: v.error };
                const parent = input.category ? findCategory(guild, sanitizeString(input.category, MAX_NAME_LENGTH)) : null;
                const ch = await guild.channels.create({
                    name: v.value,
                    type: ChannelType.GuildStageVoice,
                    parent: parent?.id || null,
                });
                logger.info('Admin tool: stage channel created', { guild: guild.id, user: userId, channel: ch.name });
                return { success: true, message: `Stage channel "${ch.name}" created.` };
            }

            case 'create_forum_channel': {
                const v = validateChannelName(input.name);
                if (!v.valid) return { success: false, message: v.error };
                const topic = validateTopic(input.topic);
                const parent = input.category ? findCategory(guild, sanitizeString(input.category, MAX_NAME_LENGTH)) : null;
                const opts = {
                    name: v.value,
                    type: ChannelType.GuildForum,
                    parent: parent?.id || null,
                };
                if (topic.value) opts.topic = topic.value;
                const ch = await guild.channels.create(opts);
                logger.info('Admin tool: forum channel created', { guild: guild.id, user: userId, channel: ch.name });
                return { success: true, message: `Forum channel #${ch.name} created.` };
            }

            // ── Channel Editing ──

            case 'edit_channel': {
                const channel = findChannelAny(guild, sanitizeString(input.channel_name, MAX_NAME_LENGTH));
                if (!channel) return { success: false, message: `Channel "${input.channel_name}" not found.` };
                const updates = {};
                if (input.new_name) {
                    const v = validateChannelName(input.new_name);
                    if (!v.valid) return { success: false, message: v.error };
                    updates.name = v.value;
                }
                if (input.topic !== undefined) { const t = validateTopic(input.topic); updates.topic = t.value || ''; }
                if (input.slowmode != null) updates.rateLimitPerUser = Math.max(0, Math.min(21600, input.slowmode));
                if (input.nsfw != null) updates.nsfw = !!input.nsfw;
                if (input.user_limit != null) updates.userLimit = Math.max(0, Math.min(99, input.user_limit));
                if (input.bitrate != null) updates.bitrate = Math.max(8000, Math.min(384000, input.bitrate));
                await channel.edit(updates);
                logger.info('Admin tool: channel edited', { guild: guild.id, user: userId, channel: channel.name, updates });
                return { success: true, message: `Channel "${input.channel_name}" updated.` };
            }

            case 'move_channel': {
                const channel = findChannelAny(guild, input.channel_name);
                if (!channel) return { success: false, message: `Channel "${input.channel_name}" not found.` };
                if (input.category_name.toLowerCase() === 'none') {
                    await channel.setParent(null);
                    return { success: true, message: `Channel "${channel.name}" removed from its category.` };
                }
                const category = findCategory(guild, input.category_name);
                if (!category) return { success: false, message: `Category "${input.category_name}" not found.` };
                await channel.setParent(category.id);
                logger.info('Admin tool: channel moved', { guild: guild.id, user: userId, channel: channel.name, category: category.name });
                return { success: true, message: `Channel "${channel.name}" moved to "${category.name}".` };
            }

            case 'set_channel_permissions': {
                const channel = findChannelAny(guild, input.channel_name);
                if (!channel) return { success: false, message: `Channel "${input.channel_name}" not found.` };

                let target;
                if (input.target_type === 'role') {
                    target = findRole(guild, input.target_name);
                    if (!target) return { success: false, message: `Role "${input.target_name}" not found.` };
                } else {
                    target = await findMember(guild, input.target_name);
                    if (!target) return { success: false, message: `User "${input.target_name}" not found.` };
                }

                const overwrites = {};
                if (input.allow) {
                    for (const perm of resolvePermissions(input.allow)) {
                        overwrites[perm] = true;
                    }
                }
                if (input.deny) {
                    for (const perm of resolvePermissions(input.deny)) {
                        overwrites[perm] = false;
                    }
                }

                await channel.permissionOverwrites.edit(target, overwrites);
                logger.info('Admin tool: channel permissions set', { guild: guild.id, user: userId, channel: channel.name, target: input.target_name });
                return { success: true, message: `Permissions updated for ${input.target_type} "${input.target_name}" in #${channel.name}.` };
            }

            // ── Role Management ──

            case 'create_role': {
                const v = validateName(input.name, 'Role name');
                if (!v.valid) return { success: false, message: v.error };
                const c = validateColor(input.color);
                if (!c.valid) return { success: false, message: c.error };
                const opts = { name: v.value };
                if (c.value) opts.color = c.value;
                if (input.hoist != null) opts.hoist = !!input.hoist;
                if (input.mentionable != null) opts.mentionable = !!input.mentionable;
                if (input.permissions) opts.permissions = resolvePermissions(input.permissions);
                const role = await guild.roles.create(opts);
                logger.info('Admin tool: role created', { guild: guild.id, user: userId, role: role.name });
                return { success: true, message: `Role "${role.name}" created.` };
            }

            case 'edit_role': {
                const role = findRole(guild, sanitizeString(input.role_name, MAX_NAME_LENGTH));
                if (!role) return { success: false, message: `Role "${input.role_name}" not found.` };
                const updates = {};
                if (input.new_name) {
                    const v = validateName(input.new_name, 'Role name');
                    if (!v.valid) return { success: false, message: v.error };
                    updates.name = v.value;
                }
                if (input.color) {
                    const c = validateColor(input.color);
                    if (!c.valid) return { success: false, message: c.error };
                    updates.color = c.value;
                }
                if (input.hoist != null) updates.hoist = !!input.hoist;
                if (input.mentionable != null) updates.mentionable = !!input.mentionable;
                if (input.permissions) updates.permissions = resolvePermissions(input.permissions);
                await role.edit(updates);
                logger.info('Admin tool: role edited', { guild: guild.id, user: userId, role: role.name, updates });
                return { success: true, message: `Role "${input.role_name}" updated.` };
            }

            case 'assign_role': {
                const member = await findMember(guild, input.username);
                if (!member) return { success: false, message: `Member "${input.username}" not found.` };
                const roles = input.role_names.map(n => findRole(guild, n)).filter(Boolean);
                if (roles.length === 0) return { success: false, message: `None of the specified roles were found.` };
                await member.roles.add(roles);
                const names = roles.map(r => r.name).join(', ');
                logger.info('Admin tool: roles assigned', { guild: guild.id, user: userId, target: member.user.username, roles: names });
                return { success: true, message: `Assigned role(s) ${names} to ${member.displayName}.` };
            }

            case 'remove_role': {
                const member = await findMember(guild, input.username);
                if (!member) return { success: false, message: `Member "${input.username}" not found.` };
                const roles = input.role_names.map(n => findRole(guild, n)).filter(Boolean);
                if (roles.length === 0) return { success: false, message: `None of the specified roles were found.` };
                await member.roles.remove(roles);
                const names = roles.map(r => r.name).join(', ');
                logger.info('Admin tool: roles removed', { guild: guild.id, user: userId, target: member.user.username, roles: names });
                return { success: true, message: `Removed role(s) ${names} from ${member.displayName}.` };
            }

            // ── Server Settings ──

            case 'edit_server': {
                const updates = {};
                if (input.name) {
                    const v = validateName(input.name, 'Server name');
                    if (!v.valid) return { success: false, message: v.error };
                    updates.name = v.value;
                }
                if (input.description !== undefined) updates.description = sanitizeString(input.description, MAX_DESCRIPTION_LENGTH);
                if (input.afk_channel) {
                    const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name.toLowerCase() === input.afk_channel.toLowerCase());
                    if (ch) updates.afkChannel = ch.id;
                    else return { success: false, message: `Voice channel "${input.afk_channel}" not found.` };
                }
                if (input.afk_timeout != null) updates.afkTimeout = input.afk_timeout;
                if (input.system_channel) {
                    const ch = findChannel(guild, input.system_channel);
                    if (ch) updates.systemChannel = ch.id;
                    else return { success: false, message: `Channel "${input.system_channel}" not found.` };
                }
                if (input.default_notifications) {
                    updates.defaultMessageNotifications = input.default_notifications === 'all_messages' ? 0 : 1;
                }
                await guild.edit(updates);
                logger.info('Admin tool: server edited', { guild: guild.id, user: userId, updates: Object.keys(updates) });
                return { success: true, message: `Server settings updated.` };
            }

            // ── Threads ──

            case 'create_thread': {
                const channel = findChannel(guild, input.channel_name);
                if (!channel) return { success: false, message: `Channel "${input.channel_name}" not found.` };
                const opts = {
                    name: input.name,
                    type: input.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
                };
                if (input.auto_archive_minutes) opts.autoArchiveDuration = input.auto_archive_minutes;
                const thread = await channel.threads.create(opts);
                logger.info('Admin tool: thread created', { guild: guild.id, user: userId, thread: thread.name });
                return { success: true, message: `Thread "${thread.name}" created in #${channel.name}.` };
            }

            case 'archive_thread': {
                const thread = findThread(guild, input.thread_name);
                if (!thread) return { success: false, message: `Thread "${input.thread_name}" not found.` };
                await thread.setArchived(input.archived);
                logger.info('Admin tool: thread archived/unarchived', { guild: guild.id, user: userId, thread: thread.name, archived: input.archived });
                return { success: true, message: `Thread "${thread.name}" ${input.archived ? 'archived' : 'unarchived'}.` };
            }

            case 'lock_thread': {
                const thread = findThread(guild, input.thread_name);
                if (!thread) return { success: false, message: `Thread "${input.thread_name}" not found.` };
                await thread.setLocked(input.locked);
                logger.info('Admin tool: thread locked/unlocked', { guild: guild.id, user: userId, thread: thread.name, locked: input.locked });
                return { success: true, message: `Thread "${thread.name}" ${input.locked ? 'locked' : 'unlocked'}.` };
            }

            // ── Emojis ──

            case 'create_emoji': {
                const emoji = await guild.emojis.create({ attachment: input.image_url, name: input.name });
                logger.info('Admin tool: emoji created', { guild: guild.id, user: userId, emoji: emoji.name });
                return { success: true, message: `Emoji :${emoji.name}: created.` };
            }

            case 'rename_emoji': {
                const emoji = guild.emojis.cache.find(e => e.name.toLowerCase() === input.current_name.toLowerCase());
                if (!emoji) return { success: false, message: `Emoji "${input.current_name}" not found.` };
                await emoji.edit({ name: input.new_name });
                logger.info('Admin tool: emoji renamed', { guild: guild.id, user: userId, from: input.current_name, to: input.new_name });
                return { success: true, message: `Emoji renamed from :${input.current_name}: to :${input.new_name}:.` };
            }

            // ── Scheduled Events ──

            case 'create_scheduled_event': {
                const opts = {
                    name: input.name,
                    scheduledStartTime: input.start_time,
                    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                };
                if (input.description) opts.description = input.description;
                if (input.end_time) opts.scheduledEndTime = input.end_time;

                if (input.type === 'voice') {
                    opts.entityType = GuildScheduledEventEntityType.Voice;
                    const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name.toLowerCase() === input.channel_name?.toLowerCase());
                    if (!ch) return { success: false, message: `Voice channel "${input.channel_name}" not found.` };
                    opts.channel = ch.id;
                } else if (input.type === 'stage') {
                    opts.entityType = GuildScheduledEventEntityType.StageInstance;
                    const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildStageVoice && c.name.toLowerCase() === input.channel_name?.toLowerCase());
                    if (!ch) return { success: false, message: `Stage channel "${input.channel_name}" not found.` };
                    opts.channel = ch.id;
                } else {
                    opts.entityType = GuildScheduledEventEntityType.External;
                    opts.entityMetadata = { location: input.location || 'TBD' };
                    if (!input.end_time) return { success: false, message: 'External events require an end time.' };
                }

                const event = await guild.scheduledEvents.create(opts);
                logger.info('Admin tool: scheduled event created', { guild: guild.id, user: userId, event: event.name });
                return { success: true, message: `Scheduled event "${event.name}" created.` };
            }

            // ── Member Management ──

            case 'set_nickname': {
                const member = await findMember(guild, input.username);
                if (!member) return { success: false, message: `Member "${input.username}" not found.` };
                await member.setNickname(input.nickname || null);
                logger.info('Admin tool: nickname set', { guild: guild.id, user: userId, target: member.user.username, nickname: input.nickname });
                return { success: true, message: input.nickname ? `Nickname for ${member.user.username} set to "${input.nickname}".` : `Nickname cleared for ${member.user.username}.` };
            }

            // ── Info / Listing ──

            case 'list_channels': {
                const categories = guild.channels.cache
                    .filter(c => c.type === ChannelType.GuildCategory)
                    .sort((a, b) => a.position - b.position);

                const uncategorized = guild.channels.cache
                    .filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
                    .sort((a, b) => a.position - b.position);

                let result = '';
                if (uncategorized.size > 0) {
                    result += '**No Category:**\n';
                    uncategorized.forEach(c => {
                        const typeLabel = c.type === ChannelType.GuildVoice ? '🔊' : c.type === ChannelType.GuildStageVoice ? '📢' : c.type === ChannelType.GuildForum ? '💬' : '#';
                        result += `  ${typeLabel} ${c.name}\n`;
                    });
                }
                categories.forEach(cat => {
                    result += `\n**${cat.name}:**\n`;
                    const children = guild.channels.cache
                        .filter(c => c.parentId === cat.id)
                        .sort((a, b) => a.position - b.position);
                    children.forEach(c => {
                        const typeLabel = c.type === ChannelType.GuildVoice ? '🔊' : c.type === ChannelType.GuildStageVoice ? '📢' : c.type === ChannelType.GuildForum ? '💬' : '#';
                        result += `  ${typeLabel} ${c.name}\n`;
                    });
                });
                return { success: true, message: result || 'No channels found.' };
            }

            case 'list_roles': {
                const roles = guild.roles.cache
                    .filter(r => r.name !== '@everyone')
                    .sort((a, b) => b.position - a.position);

                const result = roles.map(r => {
                    const color = r.hexColor !== '#000000' ? ` (${r.hexColor})` : '';
                    return `• **${r.name}**${color} — ${r.members.size} member${r.members.size !== 1 ? 's' : ''}`;
                }).join('\n');

                return { success: true, message: result || 'No roles found.' };
            }

            default:
                return { success: false, message: `Unknown tool: ${toolName}` };
        }
    } catch (error) {
        logger.error('Admin tool execution failed', { toolName, error: error.message, stack: error.stack });
        await notifyError({
            title: `Admin tool failed: ${toolName}`,
            error,
            context: { guild: guild.id, user: userId, tool: toolName, input: JSON.stringify(input).slice(0, 300) },
        });
        return { success: false, message: 'Something went wrong executing that action. The error has been reported.' };
    }
}
