# Discord Bot — Claude Sonnet 4.6

A Discord bot powered by Claude Sonnet 4.6 with an evolving personality system, strict token budget enforcement, and admin slash commands.

## Prerequisites

- Node.js 20 or newer
- PM2 installed globally (`npm install -g pm2`)
- A Discord bot application with a token and client ID
- An Anthropic API key
- The bot must have these Discord Gateway Intents enabled in the Developer Portal: **Message Content**, **Server Members**

## Setup

```bash
git clone <repo>
cd discord-bot
npm install
cp .env.example .env
# Fill in .env with your tokens and keys
node src/commands/register.js   # Register slash commands (run once)
pm2 start ecosystem.config.js   # Start the bot
pm2 startup                     # Auto-start on reboot
pm2 save                        # Save the process list
```

## Discord Bot Permissions

The bot needs these permissions:

- Send Messages
- Read Message History
- Manage Channels
- Ban Members
- Kick Members
- Manage Messages
- Add Reactions
- Use Slash Commands

**Permissions integer:** `1507328214086`

Use this URL to invite the bot (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1507328214086&scope=bot%20applications.commands
```

## Commands

| Command | Permission | Description |
|---------|-----------|-------------|
| `/create-channel` | Manage Channels | Create a new text channel |
| `/delete-channel` | Manage Channels | Delete a channel (with confirmation) |
| `/ban` | Ban Members | Ban a user with optional reason |
| `/kick` | Kick Members | Kick a user with optional reason |
| `/purge` | Manage Messages | Bulk delete 1-100 messages |
| `/budget` | None | Check monthly API token spend |

## How the Bot Works

**Chatting:** @mention the bot to talk to it. It responds using Claude Sonnet 4.6 with short-term context (last 3 exchanges per user per channel).

**Personality System:** The bot starts with a base personality and evolves it over time. Every 15 interactions, it runs a "dream digest" — a cheap API call that compresses recent conversations into an updated personality prompt (max 500 characters). This means the bot adapts to the server's vibe without storing or replaying long conversation logs.

**Token Budget:** The bot enforces a hard $20/month API budget. Every API call is tracked and the bot stops responding when the limit is hit. Check spend with `/budget`.

## Monitoring

```bash
pm2 logs discord-bot    # View live logs
pm2 status              # Process status
pm2 monit               # CPU/memory monitor
```

Logs are written to `./logs/`.

Use the `/budget` slash command to check monthly API spend from Discord.

## Configuration

All configuration is via environment variables in `.env`. See `.env.example` for all options with defaults.

Key tuning options:
- `MONTHLY_TOKEN_BUDGET_USD` — Hard budget cap (default: $20)
- `MAX_RESPONSE_TOKENS` — Max tokens per response (default: 512)
- `PERSONALITY_DIGEST_INTERVAL` — Interactions between personality updates (default: 15)
- `MAX_HISTORY_MESSAGES` — Context messages sent to the API (default: 6)
