# Telegram Score Bot — Vercel

Simple Telegram group score bot using Vercel Functions and Vercel Postgres.

## Features

- `/start` sends an Add to Group button
- Two score keywords:
  - ک م خ
  - ک م م خ
- Either keyword gives the sender 1 point
- One point maximum per message, even if a keyword appears multiple times
- Daily top 3
- Weekly top 3
- A persistent leaderboard message in each group
- `/tops`, `/top`, `/برترین`
- `/score`, `/امتیاز`
- Duplicate Telegram update protection
- Scores are separated by group
- All user-facing text and keywords are in `config.js`

## Deploy

Import the repository into Vercel.

Add the environment variable:

`BOT_TOKEN`

Then connect a Vercel Postgres database and add the environment variables supplied by Vercel for that database.

Deploy the project.

Set the Telegram webhook to:

`https://YOUR-DOMAIN.vercel.app/api/webhook`

For example:

`https://api.telegram.org/botBOT_TOKEN/setWebhook?url=https://YOUR-DOMAIN.vercel.app/api/webhook&allowed_updates=["message","my_chat_member"]`

## Telegram

Disable Group Privacy in BotFather so the bot can receive normal group messages.

The bot should be able to send messages and edit its leaderboard message.

## Configuration

Edit `config.js`.

Change:

`keywords`

to change the two scoring phrases.

Do not put `BOT_TOKEN` in GitHub.
