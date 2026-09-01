# Telegram AI Bot

This project has two separate processes:

- `npm start` starts `index.js`, which runs the Telegram long-polling chatbot and its configurable posting schedule.
- GitHub Actions runs `post.js` once per day for the independent scheduled channel post.

## Required configuration

Copy `.env.example` to `.env` and set each value. Never commit `.env`.

The chatbot requires a valid `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY`. If Groq returns `401 Invalid API Key`, generate a new API key in the Groq console, update `GROQ_API_KEY` in the hosting environment and local `.env`, then redeploy/restart the service. The key used by this repository was verified on 2026-09-01 and returned that error.

`SUPABASE_URL` and `SUPABASE_KEY` support conversation memory. The `chat_history` table must contain `chat_id`, `role`, `message`, and `created_at` columns.

## Run and verify

```bash
npm install
npm start
```

The startup logs should show `Telegram polling started for @...`. Send a private message to the bot and inspect hosting logs for `Reply bhej diya!` or a specific API error.

## GitHub Actions secrets

The daily workflow uses repository secrets for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SERPAPI_KEY`, `GROQ_API_KEY`, and `PIXABAY_KEY`. Update the `GROQ_API_KEY` secret as well so daily generated posts keep working after the key is replaced.
