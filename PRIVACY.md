# DiVA — Privacy Policy

**Last updated:** April 27, 2026
**Effective version:** v1.2.1

This Privacy Policy explains what data **DiVA** (the "Bot," "Service," "we," "us") collects, how it is used, who it is shared with, and how long it is kept. It applies to the **publicly hosted (managed) instance of DiVA** that the maintainer operates and invites to Discord servers.

> **Self-hosted instances:** DiVA is open-source software released under the MIT License. If you are using a copy that someone else hosts (i.e. anyone other than the maintainer), the operator of that instance is the data controller — **this policy does not apply to them.** Ask the operator for their own privacy policy. The terms below describe only the maintainer-run instance.

---

## 1. Who we are

- **Service:** DiVA (Discord Virtual Assistant) — a Discord bot powered by Anthropic's Claude AI.
- **Operator (managed instance):** the project maintainer ("DiVA Operator").
- **Source code:** [github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant](https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant) (MIT License).
- **Contact:** open a GitHub issue, or DM the maintainer on Discord. A dedicated support email may be added in a future update.

---

## 2. Summary (TL;DR)

- DiVA processes Discord messages **only when invoked** (mention, reply-to-bot, slash command, or DM).
- Message content is **sent to Anthropic** (Claude API) so the AI can generate a reply. Anthropic is our only AI sub-processor.
- We store messages, reminders, server credit balances, and a few user preferences (timezone, secretary digest opt-in) in a SQLite database.
- We **do not sell your data**, run analytics SDKs, or share data with advertisers.
- You can ask the server admin to remove DiVA from your server, or contact the operator to delete your personal data, at any time.

---

## 3. Information we collect

DiVA only collects what it needs to function. Below is an exhaustive list — there is nothing collected that is not listed here.

### 3.1 Discord-provided identifiers

When DiVA is invited to a server or a user interacts with it:

- **Discord User ID** (your numeric Discord snowflake) and **username** at the time of the interaction
- **Discord Guild (server) ID** and channel ID where the interaction happened
- **Message ID** (used to thread replies and to attach interactive buttons)

These come from Discord's normal bot API. We never ask for an OAuth scope beyond what Discord requires for a bot to read mentioned messages and post replies.

### 3.2 Message content

- The **text of any message** in which DiVA is mentioned, replied to, or DM'd, plus any **image attachments** posted in that message
- For context: when you reply to another user's message and mention DiVA, the **text of the message you replied to** (and its author's username) is also processed, so the bot can understand what you're referring to
- For context: the **last 5 message exchanges** between any users and the bot in the same channel (the bot's "channel memory") are retrieved when generating a new reply, so the bot can follow the conversation
- For server personality evolution: roughly every 15 interactions, the bot summarizes recent message snippets (each truncated to 150 characters) into a short "personality digest" so it can adapt its tone to your server. Snippets from messages **other than yours** may be included in this digest.

### 3.3 Reminders

- The **reminder text** you write (or speak in natural language)
- The **fire time** in UTC and your timezone
- For recurring reminders: the recurrence pattern (daily / weekly + weekday) and your local fire time
- The channel ID where you set it (so one-shot reminders can fire there)

When you ask DiVA to suggest a title for a reminder, the reminder text is sent to Anthropic to generate a short title.

### 3.4 User preferences

- Your **timezone** (an IANA name like `America/Los_Angeles`) — set via `/timezone` or asked of the bot in chat
- Your **secretary mode** settings: enabled (yes/no), digest delivery time, delivery channel (or DM)
- Last time a digest was sent to you (so we don't send duplicates)

### 3.5 Server (guild) settings

- Per-server **credit balance** (lifetime credits granted, total spent so far)
- A **transaction log** of credit top-ups, refunds, and operator adjustments
- Optional channel routing: which channel should receive errors, weekly metrics, or update notices for your server
- Whether your server has opted out of update notices

### 3.6 AI usage records

- Per-message **token counts and cost in USD** are recorded against the server. This is used for billing, the `/budget` command, and to enforce out-of-credits gating.

### 3.7 Operational logs

- The bot writes **operational logs** (errors, warnings, info events) to its hosting environment. These can include user IDs, guild IDs, message IDs, and brief descriptions of what happened (e.g. "reminder fired"). Logs are not indexed or queried for analytics — they exist only to debug failures.

### 3.8 What we **do not** collect

- We do **not** collect IP addresses, device identifiers, browser fingerprints, or location beyond your declared timezone.
- We do **not** run third-party analytics, tracking pixels, or advertising SDKs.
- We do **not** scan your server's messages outside of replies addressed to the bot, except for the limited "last 5 messages in this channel" context buffer described in §3.2.
- We do **not** read or store voice channel audio, video, or screen-share content.
- We do **not** collect billing or payment information today. (When paid credit packs ship, payment is handled by Stripe — see §5.)

---

## 4. How we use data

We use the data above to:

1. **Generate AI replies** — by sending the conversation context to Anthropic's Claude API.
2. **Run reminders and the daily secretary digest** — by storing fire times in our database and posting the messages back to Discord at the right time.
3. **Adapt the bot's personality per server** — by summarizing recent conversations into a short prompt that gets prepended to future replies in that server.
4. **Bill servers for AI usage** — by tallying token costs and gating chat once a server runs out of credits.
5. **Operate the service** — restart-recovery, error reporting to operators, and security monitoring.
6. **Communicate updates** — by posting a short release note to your server's notices channel when a new version ships (your admin can disable this with `/notices off`).

We do **not** train any AI model on your data, and we do not sell, rent, or trade your data.

---

## 5. Sub-processors and third parties

DiVA's managed instance uses these third parties to operate. Each one has its own privacy policy that governs what it does with the data we send it.

| Sub-processor | What we send | Purpose | Privacy policy |
|---|---|---|---|
| **Anthropic** (Claude API) | Message content, reply-chain context, channel memory snippets, image URLs, reminder text (for title suggestions), web-search queries, your username and Discord user ID, your timezone | Generate AI responses | [anthropic.com/legal/privacy](https://www.anthropic.com/legal/privacy) |
| **Discord** | Everything DiVA posts back to Discord; everything Discord sends DiVA via the bot API | Deliver messages | [discord.com/privacy](https://discord.com/privacy) |
| **Railway** (hosting) | Encrypted-in-transit connections; the SQLite database file lives on Railway's persistent volume | Run the bot's process and store data | [railway.com/legal/privacy](https://railway.com/legal/privacy) |
| **Stripe** (planned, for paid credit packs) | Billing email and payment method (collected by Stripe directly — never seen by DiVA) | Process credit-pack purchases | [stripe.com/privacy](https://stripe.com/privacy) |

We do **not** add new sub-processors silently. If a new one is introduced, this document and the in-server `/notices` update will mention it.

---

## 6. How long we keep data

| Data | Retention |
|---|---|
| Conversation/channel memory rows (`conversations` table) | **14 days**, then auto-deleted on a daily sweep |
| Fired or cancelled reminders | **30 days** after firing/cancellation, then auto-deleted |
| Active reminders (pending or recurring) | Until they fire, are cancelled, or you delete them |
| User settings (timezone, secretary prefs) | Until you ask us to delete them, or your account is removed |
| Server credit balance and transaction log | **Indefinitely** for accounting integrity (we can anonymize on request — see §7) |
| Per-message token/cost records (`token_usage`) | **Indefinitely** for accounting; can be anonymized on request |
| Server personality prompt (`guild_personality`) | Until DiVA is removed from the server, or it is reset via `/personality reset` |
| Database backups (Railway volume) | **10 days** rolling — older snapshots are deleted automatically |
| Operational logs | Up to **30 days** at the hosting layer |

When DiVA is removed from a server, we keep the credit ledger (for accounting) but ongoing data collection in that server stops immediately.

---

## 7. Your rights

If you are in the EU, UK, California, or another jurisdiction with data-protection laws, you have the right to:

- **Access** the personal data we hold about you
- **Correct** inaccurate data (your timezone, for example, is editable via `/timezone`)
- **Delete** your data ("right to be forgotten")
- **Port** your data — receive it in a machine-readable JSON file
- **Object** to processing or **withdraw consent**

To exercise any of these rights, open a GitHub issue or contact the operator on Discord. We will respond within **30 days**.

> Some data is intentionally anonymized rather than deleted — for example, the `token_usage` row that proves your server spent $0.0034 will be retained but stripped of your user ID, because deleting it would corrupt server billing. We will tell you exactly what we did when we respond to a deletion request.

A self-service `/data-export` and `/data-delete` command is on the roadmap.

---

## 8. Children

DiVA is not directed at children under 13 (or 16 in some EU states). Discord's own Terms of Service require users to meet Discord's minimum age. If you believe a child has used DiVA in violation of this, contact us and we will delete the relevant data.

---

## 9. Security

- Database connections use WAL-mode SQLite over a local filesystem inside the Railway container — not exposed to the public internet.
- API keys (Discord token, Anthropic key) are stored as environment variables at the hosting provider, never committed to source control.
- TLS protects all in-transit traffic (Discord ↔ DiVA, DiVA ↔ Anthropic).
- The on-disk SQLite file and its backups on the Railway volume are **not encrypted at rest**. Encrypted-volume migration is on the roadmap before we offer paid plans.
- We never log raw API keys, tokens, or message content to operational logs.

No system is perfectly secure. If you discover a vulnerability, please report it via a private GitHub Security Advisory rather than a public issue.

---

## 10. International transfers

DiVA's hosting is located in regions Railway operates (currently US-based). When you interact with the bot, your data may be transferred to and processed in the United States. By using the managed instance, you consent to this transfer.

For users in the EU/UK: we rely on the standard contractual clauses where applicable for transfers to our sub-processors.

---

## 11. Changes to this policy

We may update this policy from time to time. The "Last updated" date at the top of the document and the bot's version number identify the current version. **Material changes** (new sub-processors, new categories of data, new retention periods) will be announced in your server's notices channel before they take effect. Continued use of DiVA after a change constitutes acceptance.

You can review the full revision history at any time in the Git history of [PRIVACY.md on GitHub](https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/blob/main/PRIVACY.md).

---

## 12. Contact

For privacy questions, data requests, or complaints:

- **GitHub:** open an issue at [github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/issues](https://github.com/Jackie-Who/DiVA-Discord-Virtual-Assistant/issues)
- **Discord:** DM the bot operator (the same Discord account that hosts the managed instance)

If we ever fail to address your concern, you have the right to lodge a complaint with your local data-protection authority.
