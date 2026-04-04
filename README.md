# Sonnet Discord Agent

A Discord bot powered by Claude AI with an evolving personality system, intelligent model routing, admin tools with confirmation/undo, per-channel memory, and strict token budget enforcement.

## Features

### AI Chat
- **Multi-model routing** — Simple/short messages route to Claude Haiku (cheaper), complex queries and admin requests use Claude Sonnet for higher quality
- **Reply chain awareness** — Walks up to 3 messages in a reply thread for full context, including images from any user in the chain
- **Per-channel memory** — Remembers the last 5 conversations in each channel so the bot knows what's been discussed recently
- **Conversation context** — Pulls recent user history from the database for direct @mentions (not just replies)
- **Image analysis** — Sees and describes images shared by users (disabled in saving mode to conserve budget)
- **Web search** — Searches the web for current events and recent info when needed

### Evolving Personality
- Every 15 interactions per server, a "dream digest" runs — a lightweight API call that compresses recent conversations into a personality prompt (max 500 chars)
- The bot naturally adapts to each server's tone, humor, slang, and vibe over time
- Admins can view and reset the personality with `/personality`

### Admin Tools (via Natural Language)
Server admins can ask the bot to manage the server through natural conversation. The bot uses Claude's tool system to execute actions:

- **Channels** — Create (text, voice, announcement, stage, forum), edit, move, set permissions
- **Roles** — Create, edit, assign/remove from members
- **Server** — Edit name, description, AFK settings, system channel
- **Threads** — Create, archive/unarchive, lock/unlock
- **Emojis** — Create from URL, rename
- **Events** — Create scheduled events (voice, stage, external)
- **Members** — Set/clear nicknames
- **Info** — List channels, list roles

All write operations require confirmation via buttons before executing. After execution, an undo button appears for 5 minutes (persisted to database, survives restarts). Destructive actions (deleting channels/roles, kicking, banning) are blocked by policy.

### Budget Management
- Hard monthly budget cap (default $20) with per-call cost tracking
- Model-aware pricing — Haiku ($1/$5 per M tokens) and Sonnet ($3/$15 per M tokens) tracked separately
- Saving mode at 85% usage — disables web search and image analysis to stretch the budget
- Full stop at 100% — bot stops responding until next month
- `/budget` command shows spend, remaining budget, and estimated exchanges left

### Monitoring & Operations
- Weekly metrics summary sent to a Discord channel (Sundays 9 PM Pacific)
- Error notifications sent to a private Discord channel with full context
- Daily database backups with 10-day retention
- Structured JSON logging with configurable levels
- Graceful shutdown on SIGTERM/SIGINT

## Prerequisites

- Node.js 20+
- A Discord bot application with **Message Content** and **Server Members** intents enabled
- An Anthropic API key

## Setup

```bash
git clone https://github.com/Jackie-Who/Sonnet-Discord-Agent.git
cd Sonnet-Discord-Agent
npm install
cp .env.example .env
# Fill in .env with your tokens and keys
node src/commands/register.js   # Register slash commands
npm start                       # Start the bot
```

### With PM2 (recommended for production)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 startup    # Auto-start on reboot
pm2 save
```

### With Docker / Railway

```bash
docker build -t discord-bot .
docker run --env-file .env -v /path/to/data:/app/data discord-bot
```

For Railway: set `DATA_DIR=/app/data` and attach a persistent volume at `/app/data`.

## Discord Bot Permissions

The bot needs these permissions:

- Send Messages, Read Message History, Add Reactions
- Manage Channels, Manage Roles, Manage Messages
- Ban Members, Kick Members
- Use Slash Commands, Manage Emojis, Manage Events, Manage Nicknames

**Permissions integer:** `1507328214086`

Invite URL (replace `YOUR_CLIENT_ID`):
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1507328214086&scope=bot%20applications.commands
```

## Slash Commands

| Command | Permission | Description |
|---------|-----------|-------------|
| `/budget` | None | Check monthly API token spend |
| `/personality view` | Administrator | View the bot's evolved personality for this server |
| `/personality reset` | Administrator | Reset the personality to start fresh |
| `/create-channel` | Manage Channels | Create a new text channel |
| `/delete-channel` | Manage Channels | Delete a channel (with confirmation) |
| `/ban` | Ban Members | Ban a user with optional reason |
| `/kick` | Kick Members | Kick a user with optional reason |
| `/purge` | Manage Messages | Bulk delete 1-100 messages |

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | *required* | Discord bot token |
| `DISCORD_CLIENT_ID` | *required* | Discord application client ID |
| `DISCORD_GUILD_IDS` | *required* | Comma-separated guild IDs |
| `ANTHROPIC_API_KEY` | *required* | Anthropic API key |
| `DATA_DIR` | project root | Database/backup directory (set for Railway) |
| `MONTHLY_TOKEN_BUDGET_USD` | `20` | Hard monthly budget cap |
| `MAX_RESPONSE_TOKENS` | `512` | Max tokens per response (admins get 4096) |
| `PERSONALITY_DIGEST_INTERVAL` | `15` | Interactions between personality digests |
| `MAX_HISTORY_MESSAGES` | `6` | Context messages sent to API per exchange |
| `RATE_LIMIT_USER_SECONDS` | `5` | Cooldown per user |
| `RATE_LIMIT_CHANNEL_COUNT` | `5` | Max messages per channel in time window |
| `HISTORY_RETENTION_DAYS` | `14` | Days to keep conversation history |
| `ERROR_CHANNEL_ID` | | Discord channel for error alerts |
| `METRICS_CHANNEL_ID` | | Discord channel for weekly metrics |
| `NOTIFY_USER_ID` | | User to @mention in alerts |

## Architecture

```
src/
  ai/
    chat.js            — Main chat logic, model routing, tool execution loop
    adminTools.js      — 22 admin tools with sanitization, confirmation, undo
    systemPrompt.js    — Dynamic system prompt builder
    personality.js     — Personality digest system
    client.js          — Anthropic SDK client
  db/
    init.js            — SQLite setup (WAL mode, 5 tables)
    history.js         — Conversation storage and channel memory queries
    personality.js     — Guild personality CRUD
    tokenBudget.js     — Token usage tracking with model-aware pricing
  commands/            — Slash command handlers
  events/              — Discord event handlers
  utils/
    rateLimiter.js     — Per-user and per-channel rate limiting
    adminRateLimiter.js — Per-guild admin tool rate limiting
    backup.js          — Daily DB backup with retention
    weeklyMetrics.js   — Weekly usage report
    errorNotifier.js   — Error alerts to Discord
    logger.js          — Structured JSON logging
```

## Tech Stack

- **Runtime:** Node.js 20+ (ESM)
- **AI:** Claude Sonnet 4.6 + Haiku 4.5 via `@anthropic-ai/sdk`
- **Discord:** discord.js v14
- **Database:** SQLite (better-sqlite3) with WAL mode
- **Deployment:** Docker / Railway / PM2
