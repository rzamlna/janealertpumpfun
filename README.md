# janealertpumpfun

Unified Telegram alert bot:
- User sends `/start` -> automatically subscribed and receives alert messages.
- User sends `/stop` -> unsubscribed.
- Bot scans Solana candidates (DexScreener feeds) and broadcasts formatted alerts to subscribers.

## Setup

```bash
cp .env.example .env
npm install
npm start
```

## Commands
- `/start` subscribe + welcome alert
- `/stop` unsubscribe
- `/status` owner-only if `OWNER_TELEGRAM_ID` is set

## Notes
- This version uses one process (`src/bot.js`) to avoid Telegram `409 Conflict` from multiple `getUpdates` pollers.
- Filters configurable in `.env`.
