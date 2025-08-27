Kiya Lottery - Telegram Bot (kl-bot)

This small project provides a Telegram bot that deep-links into the Kiya Lottery MiniApp and sends scheduled reminders.

Files created

- bot.js - main bot script (polling mode)
- package.json - project dependencies and scripts
- .env.example - environment variables example
- data/users.json (created at runtime) - persisted user registry

Quick start

1. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.

2. Install dependencies (from `kl-bot`):

```powershell
cd kl-bot
pnpm install
# or npm install
```

3. Run the bot:

```powershell
pnpm start
# or npm start
```

Commands supported by the bot

- /start - open MiniApp with `?userId=<telegramId>&action=handle_start`
- /deposit - open MiniApp deposit page
- /balance - open MiniApp wallet page
- /todays_lotteries - open MiniApp home (lotteries list)
- /unsubscribe - stop scheduled reminders
- /subscribe - (re)enable scheduled reminders

Notes

- The bot persists known users in `data/users.json` so reminders survive restarts.
- For production, consider switching to webhook mode and securing the webhook.
- Do not rely on Telegram user id alone for authenticated wallet actions; require app login/linking before sensitive operations.

If you want, I can also:

- Convert the bot to webhook mode (Express scaffold)
- Add account-linking endpoints to your backend so MiniApp can map Telegram ids to app users
- Add admin commands to query pending deposits

