import 'dotenv/config';
import fs from 'node:fs';

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerId: process.env.OWNER_TELEGRAM_ID || '',
  pollMs: Number(process.env.POLL_INTERVAL_MS || 30000),
  maxAgeMin: Number(process.env.MAX_AGE_MINUTES || 45),
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 10000),
  minMcap: Number(process.env.MIN_MCAP_USD || 20000),
  maxMcap: Number(process.env.MAX_MCAP_USD || 150000),
  minBuySellRatio: Number(process.env.MIN_BUY_SELL_RATIO || 1.2),
  minVol24h: Number(process.env.MIN_VOLUME_24H_USD || 100000),
  chainId: process.env.CHAIN_ID || 'solana',
  startAlertText:
    process.env.START_ALERT_TEXT ||
    '🚨 Alert aktif! Kamu sudah subscribe alert token. Ketik /stop untuk berhenti.',
  stateFile: process.env.STATE_FILE || './state.json',
};

if (!CFG.token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

function loadState() {
  try {
    const raw = fs.readFileSync(CFG.stateFile, 'utf8');
    const s = JSON.parse(raw);
    s.subscribers = Array.isArray(s.subscribers) ? s.subscribers : [];
    s.sent = Array.isArray(s.sent) ? s.sent : [];
    return s;
  } catch {
    return { subscribers: [], sent: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
}

const state = loadState();
const sentSet = new Set(state.sent);
let offset = 0;

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function ageMinutes(ts) {
  if (!ts) return 99999;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return 99999;
  return (Date.now() - t) / 60000;
}

function formatUsd(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function isOwner(msg) {
  if (!CFG.ownerId) return true;
  return String(msg?.from?.id || '') === String(CFG.ownerId);
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${CFG.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendMessage(chatId, text) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: false,
    parse_mode: 'HTML',
  });
}

function pickGoodPairs(pairs) {
  return pairs
    .filter((p) => (p.chainId || '').toLowerCase() === CFG.chainId)
    .map((p) => {
      const mc = toNum(p.marketCap);
      const liq = toNum(p.liquidity?.usd);
      const vol = toNum(p.volume?.h24);
      const buys = toNum(p.txns?.h1?.buys);
      const sells = toNum(p.txns?.h1?.sells);
      const ratio = sells > 0 ? buys / sells : buys;
      const age = ageMinutes(p.pairCreatedAt);

      return { p, mc, liq, vol, buys, sells, ratio, age };
    })
    .filter((x) => x.age <= CFG.maxAgeMin)
    .filter((x) => x.liq >= CFG.minLiquidity)
    .filter((x) => x.mc >= CFG.minMcap && x.mc <= CFG.maxMcap)
    .filter((x) => x.vol >= CFG.minVol24h)
    .filter((x) => x.ratio >= CFG.minBuySellRatio)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 5);
}

async function fetchPairs() {
  const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!res.ok) return [];
  const boosted = await res.json().catch(() => []);

  const pairs = [];
  for (const b of Array.isArray(boosted) ? boosted.slice(0, 30) : []) {
    if (b.chainId !== 'solana' || !b.tokenAddress) continue;
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${b.tokenAddress}`).catch(() => null);
    if (!r || !r.ok) continue;
    const j = await r.json().catch(() => null);
    const arr = Array.isArray(j?.pairs) ? j.pairs : [];
    pairs.push(...arr);
  }

  const uniq = new Map();
  for (const p of pairs) {
    const key = p.pairAddress || `${p.chainId}:${p.baseToken?.address}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }

  return [...uniq.values()];
}

function buildMessage(item) {
  const { p, mc, liq, vol, buys, sells, ratio, age } = item;
  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || '?';
  const ca = p.baseToken?.address || '-';
  const pairUrl = p.url || `https://dexscreener.com/solana/${p.pairAddress}`;

  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + (liq / 2000) + (vol / 20000))));

  return [
    `━━━━━━━━━━━━━━━━━━`,
    `🚨 <b>GLOBAL CALL</b> 🟢`,
    `<b>${name} (${symbol})</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💵 <b>Price:</b> ${p.priceUsd ? `$${p.priceUsd}` : '-'}`,
    `📈 <b>24H:</b> ${toNum(p.priceChange?.h24).toFixed(2)}%`,
    `⭐ <b>Score:</b> ${score}/100`,
    ``,
    `📊 <b>Metrics</b>`,
    `• MCAP: ${formatUsd(mc)}`,
    `• LIQ: ${formatUsd(liq)}`,
    `• VOL 24H: ${formatUsd(vol)}`,
    `• Age: ${age.toFixed(1)}m`,
    ``,
    `🧾 <b>Flow</b>`,
    `• 1H Buys/Sells: ${buys}/${sells} (ratio ${ratio.toFixed(2)})`,
    ``,
    `📌 <b>CA</b>`,
    `<code>${ca}</code>`,
    `🔗 <a href="${pairUrl}">DexScreener</a>`,
    `━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

async function handleCommands() {
  try {
    const updates = await tg('getUpdates', { timeout: 20, offset });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (!msg?.text) continue;
      const text = msg.text.trim();
      const chatId = msg.chat.id;

      if (text.startsWith('/start')) {
        if (!state.subscribers.includes(chatId)) {
          state.subscribers.push(chatId);
          saveState(state);
        }
        await sendMessage(chatId, CFG.startAlertText);
      }

      if (text === '/stop') {
        state.subscribers = state.subscribers.filter((id) => id !== chatId);
        saveState(state);
        await sendMessage(chatId, '🛑 Unsubscribed. Kamu tidak akan menerima alert lagi.');
      }

      if (text === '/status' && isOwner(msg)) {
        await sendMessage(chatId, `Subscribers: ${state.subscribers.length}\nSent cache: ${sentSet.size}`);
      }
    }
  } catch (e) {
    console.error('[updates] error:', e.message || String(e));
  }
}

async function scanAndBroadcast() {
  try {
    if (state.subscribers.length === 0) return;

    const pairs = await fetchPairs();
    const picks = pickGoodPairs(pairs);

    for (const item of picks) {
      const id = item.p?.pairAddress || item.p?.baseToken?.address;
      if (!id || sentSet.has(id)) continue;

      const msg = buildMessage(item);
      for (const chatId of state.subscribers) {
        try {
          await sendMessage(chatId, msg);
        } catch (e) {
          console.error(`[broadcast] chat ${chatId} failed:`, e.message || String(e));
        }
      }

      sentSet.add(id);
      state.sent = [...sentSet].slice(-5000);
      saveState(state);
    }

    console.log(`[scan] subscribers=${state.subscribers.length} scanned=${pairs.length} picks=${picks.length} sentSet=${sentSet.size}`);
  } catch (e) {
    console.error('[scan] error:', e.message || String(e));
  }
}

console.log('pump-alert unified bot started');
await handleCommands();
setInterval(handleCommands, 5000);
setInterval(scanAndBroadcast, CFG.pollMs);
