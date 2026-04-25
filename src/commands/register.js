import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import config from '../config.js';

const commands = [
    // Bot-specific commands. Discord-native operations (ban/kick/purge/create-channel/
    // delete-channel) were intentionally removed in v1.2 — Discord's own UI handles them
    // better, and the bot's natural-language admin tools cover the same actions when needed.

    new SlashCommandBuilder()
        .setName('budget')
        .setDescription('Show this server\'s credit balance and recent spend'),

    new SlashCommandBuilder()
        .setName('credits')
        .setDescription('Manage this server\'s credits')
        .addSubcommand(sub =>
            sub.setName('show').setDescription('Show this server\'s credit balance')
        )
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Owner only — add credits to a server')
                .addStringOption(opt => opt.setName('guild_id').setDescription('Target guild ID').setRequired(true))
                .addNumberOption(opt => opt.setName('amount').setDescription('USD to add').setRequired(true).setMinValue(0.01))
                .addStringOption(opt => opt.setName('note').setDescription('Reason / reference'))
        ),

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

    new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('Set your timezone (used for reminders and the daily digest)')
        .addStringOption(opt =>
            opt.setName('zone')
                .setDescription('IANA timezone name, e.g., America/Los_Angeles')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('reminder')
        .setDescription('Manage your reminders')
        .addSubcommand(sub =>
            sub.setName('list').setDescription('List your active reminders')
        )
        .addSubcommand(sub =>
            sub.setName('delete')
                .setDescription('Delete a reminder by ID')
                .addIntegerOption(opt => opt.setName('id').setDescription('Reminder ID (from /reminder list)').setRequired(true))
        ),

    new SlashCommandBuilder()
        .setName('secretary')
        .setDescription('Configure your personal preferences (delivery, daily digest)')
        .addSubcommand(sub =>
            sub.setName('on').setDescription('Set up or update your preferences')
        )
        .addSubcommand(sub =>
            sub.setName('off').setDescription('Disable the daily digest (recurring reminders keep working)')
        )
        .addSubcommand(sub =>
            sub.setName('status').setDescription('Show your current preferences')
        )
        .addSubcommand(sub =>
            sub.setName('clear').setDescription('Clear all your preferences (also stops recurring reminders)')
        ),

    new SlashCommandBuilder()
        .setName('channel')
        .setDescription('Configure server-side channels for bot notifications')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Route a notification kind to a channel')
                .addStringOption(opt =>
                    opt.setName('kind')
                        .setDescription('Which kind of notification')
                        .setRequired(true)
                        .addChoices(
                            { name: 'error', value: 'error' },
                            { name: 'metrics', value: 'metrics' },
                            { name: 'notices', value: 'notices' },
                        )
                )
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Target channel')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('show').setDescription('Show current channel configuration')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName('notices')
        .setDescription('Toggle update notices for this server')
        .addSubcommand(sub =>
            sub.setName('on').setDescription('Enable update notices (default)')
        )
        .addSubcommand(sub =>
            sub.setName('off').setDescription('Disable update notices')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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
