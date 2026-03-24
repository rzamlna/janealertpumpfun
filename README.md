# janealertpumpfun (Helius full source)

Unified Telegram alert bot:
- `/start` => auto subscribe + welcome alert
- `/stop` => unsubscribe
- `/status` => owner-only status
- `/topcall` => show top 10 tokens by biggest milestone reached
- Discovery source: **Helius RPC** (pump.fun program activity)
- Enrichment source: DexScreener (mcap/liquidity/volume/price)
- Milestone alerts: dynamic from `START_MULTIPLE` (default 1.5x) and then every `STEP_MULTIPLE` (default +0.5x), unlimited
- Milestone messages auto-reply to the original call message (per chat)
- If token image is available from DexScreener, call is sent as photo + caption
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
