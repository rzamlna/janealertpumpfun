import 'dotenv/config';

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  pollMs: Number(process.env.POLL_INTERVAL_MS || 30000),
  maxAgeMin: Number(process.env.MAX_AGE_MINUTES || 45),
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 10000),
  minMcap: Number(process.env.MIN_MCAP_USD || 20000),
  maxMcap: Number(process.env.MAX_MCAP_USD || 150000),
  minBuySellRatio: Number(process.env.MIN_BUY_SELL_RATIO || 1.2),
  minVol24h: Number(process.env.MIN_VOLUME_24H_USD || 100000),
  chainId: process.env.CHAIN_ID || 'solana',
};

if (!CFG.token || !CFG.chatId) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

const sent = new Set();

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
  // DexScreener public endpoint for latest pairs
  const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  // Fallback strategy: if endpoint is limited, return [] and keep bot running.
  if (!res.ok) return [];
  const data = await res.json();
  const basePairs = Array.isArray(data.pairs) ? data.pairs : [];

  // Add boosted pairs feed as supplementary candidates
  const boostedRes = await fetch('https://api.dexscreener.com/token-boosts/latest/v1').catch(() => null);
  if (boostedRes && boostedRes.ok) {
    const boosted = await boostedRes.json().catch(() => []);
    for (const b of Array.isArray(boosted) ? boosted : []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${b.tokenAddress}`).catch(() => null);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
          basePairs.push(...pairs);
        }
      }
    }
  }

  const uniq = new Map();
  for (const p of basePairs) {
    const key = p.pairAddress || `${p.chainId}:${p.baseToken?.address}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }

  return [...uniq.values()];
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CFG.token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CFG.chatId,
      text,
      disable_web_page_preview: false,
      parse_mode: 'HTML',
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Telegram send failed: ${res.status} ${t}`);
  }
}

function buildMessage(item) {
  const { p, mc, liq, vol, buys, sells, ratio, age } = item;
  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || '?';
  const ca = p.baseToken?.address || '-';
  const dex = p.dexId || '-';
  const pairUrl = p.url || `https://dexscreener.com/solana/${p.pairAddress}`;

  return [
    `🚨 <b>NEW TOKEN ALERT</b>`,
    '',
    `🪙 <b>${name}</b> ($${symbol})`,
    `⏱ Age: ${age.toFixed(1)}m`,
    `💰 MCAP: ${formatUsd(mc)}`,
    `💧 LIQ: ${formatUsd(liq)}`,
    `📊 VOL 24H: ${formatUsd(vol)}`,
    `🧾 1H Txns: B ${buys} / S ${sells} (ratio ${ratio.toFixed(2)})`,
    `🏦 DEX: ${dex}`,
    '',
    `CA: <code>${ca}</code>`,
    `🔗 <a href="${pairUrl}">DexScreener</a>`,
  ].join('\n');
}

async function tick() {
  try {
    const pairs = await fetchPairs();
    const picks = pickGoodPairs(pairs);

    for (const item of picks) {
      const id = item.p?.pairAddress || item.p?.baseToken?.address;
      if (!id || sent.has(id)) continue;

      const msg = buildMessage(item);
      await sendTelegram(msg);
      sent.add(id);

      // prevent memory blow up
      if (sent.size > 5000) {
        const first = sent.values().next().value;
        sent.delete(first);
      }
    }

    console.log(`[tick] scanned=${pairs.length} picks=${picks.length} sentSet=${sent.size}`);
  } catch (e) {
    console.error('[tick] error:', e.message || String(e));
  }
}

console.log('pump-alert-bot started');
await tick();
setInterval(tick, CFG.pollMs);
