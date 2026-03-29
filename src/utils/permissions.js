import { PermissionsBitField } from 'discord.js';

export function hasPermission(member, permission) {
    return member.permissions.has(PermissionsBitField.Flags[permission]);
}

export function canModerate(moderator, target) {
    if (!moderator.roles.highest || !target.roles.highest) return false;
    return moderator.roles.highest.position > target.roles.highest.position;
}

export function botCanModerate(guild, target) {
    const botMember = guild.members.me;
    if (!botMember || !botMember.roles.highest || !target.roles.highest) return false;
    return botMember.roles.highest.position > target.roles.highest.position;
}
