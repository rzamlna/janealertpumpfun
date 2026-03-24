# janealertpumpfun (Helius full source)

Unified Telegram alert bot:
- `/start` => auto subscribe + welcome alert
- `/stop` => unsubscribe
- `/status` => owner-only status
- Discovery source: **Helius RPC** (pump.fun program activity)
- Enrichment source: DexScreener (mcap/liquidity/volume/price)
- Milestone alerts: auto send when called token reaches `2x/3x/5x/10x/20x/50x/100x` MCAP (configurable)
- Buy/sell ratio filter removed to allow more calls

## Setup

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN + HELIUS_API_KEY (+ optional OWNER_TELEGRAM_ID)
npm install
npm start
```

## Notes
- Uses one process (`src/bot.js`) to avoid Telegram `409 Conflict`.
- Keeps local `state.json` for subscribers, sent cache, and processed signatures.
- Quality filters configurable in `.env`.
