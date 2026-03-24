# pump-alert-bot

Simple Telegram alert bot for fresh Solana tokens (DexScreener-based) with basic quality filters.

## Setup

1. Copy env file:
```bash
cp .env.example .env
```

2. Fill `.env`:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

3. Install deps:
```bash
npm install
```

4. Run:
```bash
npm start
```

## Notes
- Uses DexScreener feeds as source.
- Filters can be tuned in `.env`.
- Prevents duplicate alerts by pair address during runtime.
- For 24/7 run, use PM2 or cron + restart policy.

## PM2 quick run
```bash
pm2 start src/index.js --name pump-alert-bot
pm2 save
```
