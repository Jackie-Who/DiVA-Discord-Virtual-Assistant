import { REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import config from '../config.js';

const commands = [
    new SlashCommandBuilder()
        .setName('create-channel')
        .setDescription('Create a new text channel')
        .addStringOption(opt => opt.setName('name').setDescription('Channel name').setRequired(true))
        .addChannelOption(opt =>
            opt.setName('category')
                .setDescription('Category to create the channel under')
                .addChannelTypes(ChannelType.GuildCategory)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName('delete-channel')
        .setDescription('Delete a text channel')
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('Channel to delete')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user from the server')
        .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban'))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from the server')
        .addUserOption(opt => opt.setName('user').setDescription('User to kick').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the kick'))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete multiple messages')
        .addIntegerOption(opt =>
            opt.setName('count')
                .setDescription('Number of messages to delete (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('budget')
        .setDescription('Check the bot\'s monthly API token budget'),

    new SlashCommandBuilder()
        .setName('personality')
        .setDescription('View or reset the bot\'s evolved personality for this server')
        .addSubcommand(sub =>
            sub.setName('view').setDescription('View the current personality prompt')
        )
        .addSubcommand(sub =>
            sub.setName('reset').setDescription('Reset the personality to start fresh')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const rest = new REST({ version: '10' }).setToken(config.discordToken);

const commandData = commands.map(c => c.toJSON());
let failed = 0;

for (const guildId of config.discordGuildIds) {
    try {
        console.log(`Registering slash commands for guild ${guildId}...`);
        await rest.put(
            Routes.applicationGuildCommands(config.discordClientId, guildId),
            { body: commandData }
        );
        console.log(`  Done — guild ${guildId}`);
    } catch (error) {
        failed++;
        console.error(`  Failed for guild ${guildId}: ${error.message}`);
    }
}

if (failed === config.discordGuildIds.length) {
    console.error('All guild registrations failed.');
    process.exit(1);
} else if (failed > 0) {
    console.log(`Finished with ${failed} failure(s). Make sure the bot is invited to all guilds.`);
} else {
    console.log('All slash commands registered successfully.');
}
