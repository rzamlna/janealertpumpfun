import 'dotenv/config';
import fs from 'node:fs';

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerId: process.env.OWNER_TELEGRAM_ID || '',
  pollMs: Number(process.env.POLL_INTERVAL_MS || 20000),

  // Filters
  maxAgeMin: Number(process.env.MAX_AGE_MINUTES || 45),
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 10000),
  minMcap: Number(process.env.MIN_MCAP_USD || 20000),
  maxMcap: Number(process.env.MAX_MCAP_USD || 150000),
  minVol24h: Number(process.env.MIN_VOLUME_24H_USD || 100000),
  chainId: process.env.CHAIN_ID || 'solana',

  // Helius
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  heliusRpcUrl: process.env.HELIUS_RPC_URL || '',
  pumpProgramId: process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  signaturesLimit: Number(process.env.HELIUS_SIGNATURES_LIMIT || 25),
  startMultiple: Number(process.env.START_MULTIPLE || 1.5),
  stepMultiple: Number(process.env.STEP_MULTIPLE || 0.5),

  // Bot behavior
  startAlertText:
    process.env.START_ALERT_TEXT ||
    '🚨 Alert aktif! Kamu sudah subscribe alert token. Ketik /stop untuk berhenti.',
  stateFile: process.env.STATE_FILE || './state.json',
};

if (!CFG.token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}
if (!CFG.heliusApiKey && !CFG.heliusRpcUrl) {
  console.error('Missing HELIUS_API_KEY or HELIUS_RPC_URL in .env');
  process.exit(1);
}

const HELIUS_RPC =
  CFG.heliusRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`;

const HELIUS_API_BASE = `https://api.helius.xyz/v0`;

function loadState() {
  try {
    const raw = fs.readFileSync(CFG.stateFile, 'utf8');
    const s = JSON.parse(raw);
    s.subscribers = Array.isArray(s.subscribers) ? s.subscribers : [];
    s.sent = Array.isArray(s.sent) ? s.sent : [];
    s.processedSignatures = Array.isArray(s.processedSignatures) ? s.processedSignatures : [];
    s.calls = s.calls && typeof s.calls === 'object' ? s.calls : {};
    return s;
  } catch {
    return { subscribers: [], sent: [], processedSignatures: [], calls: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
}

const state = loadState();
const sentSet = new Set(state.sent);
const processedSigSet = new Set(state.processedSignatures);
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

async function sendPhoto(chatId, imageUrl, caption) {
  try {
    return await tg('sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption,
      parse_mode: 'HTML',
    });
  } catch (e) {
    // Fallback ke sendMessage kalau foto gagal (URL invalid, dll)
    console.warn(`[sendPhoto] fallback to sendMessage for chat ${chatId}:`, e.message || String(e));
    return sendMessage(chatId, caption);
  }
}

async function heliusRpc(method, params) {
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} rpc error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ─── NEW: Fetch top 10 holders via Helius API ────────────────────────────────
async function fetchTopHolders(mintAddress) {
  try {
    const url = `${HELIUS_API_BASE}/token-accounts?api-key=${CFG.heliusApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mintAccounts: [mintAddress],
        includeNativeBalance: false,
        displayOptions: {},
      }),
    });

    if (!res.ok) return null;
    const json = await res.json();

    // json is array of token accounts
    const accounts = Array.isArray(json) ? json : [];

    // Sum total supply from accounts
    const totalSupply = accounts.reduce((sum, a) => sum + toNum(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount), 0);
    if (totalSupply <= 0) return null;

    // Sort by balance descending, take top 10
    const sorted = accounts
      .map((a) => ({
        owner: a.account?.data?.parsed?.info?.owner || a.owner || '?',
        amount: toNum(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount),
      }))
      .filter((a) => a.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return sorted.map((a, i) => ({
      rank: i + 1,
      owner: a.owner,
      pct: totalSupply > 0 ? ((a.amount / totalSupply) * 100).toFixed(2) : '0.00',
    }));
  } catch (e) {
    console.error('[fetchTopHolders] error:', e.message || String(e));
    return null;
  }
}

// ─── Extract social links + image URL dari DexScreener pair data ────────────
function extractSocials(pair) {
  const info = pair?.info || {};
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const websites = Array.isArray(info.websites) ? info.websites : [];

  const result = {};

  for (const s of socials) {
    const type = (s.type || '').toLowerCase();
    if (type === 'twitter' && s.url) result.twitter = s.url;
    if (type === 'telegram' && s.url) result.telegram = s.url;
    if (type === 'discord' && s.url) result.discord = s.url;
  }

  if (websites.length > 0 && websites[0].url) {
    result.website = websites[0].url;
  }

  // Ambil image URL token dari DexScreener
  result.imageUrl = info.imageUrl || null;

  return result;
}

// ─── NEW: Format top holders block ──────────────────────────────────────────
function formatHoldersBlock(holders) {
  if (!holders || !holders.length) return null;

  const top3Pct = holders.slice(0, 3).reduce((sum, h) => sum + parseFloat(h.pct), 0);
  const top10Pct = holders.reduce((sum, h) => sum + parseFloat(h.pct), 0);

  const rows = holders
    .map((h) => {
      const shortOwner = `${h.owner.slice(0, 4)}...${h.owner.slice(-4)}`;
      return `  ${h.rank}. <code>${shortOwner}</code> — ${h.pct}%`;
    })
    .join('\n');

  return [
    `👥 <b>Top 10 Holders</b>`,
    rows,
    `• Top 3: ${top3Pct.toFixed(2)}% | Top 10: ${top10Pct.toFixed(2)}%`,
  ].join('\n');
}

// ─── NEW: Format socials block ───────────────────────────────────────────────
function formatSocialsBlock(socials) {
  if (!socials || !Object.keys(socials).length) return null;

  const links = [];
  if (socials.twitter) links.push(`🐦 <a href="${socials.twitter}">Twitter</a>`);
  if (socials.telegram) links.push(`💬 <a href="${socials.telegram}">Telegram</a>`);
  if (socials.discord) links.push(`🎮 <a href="${socials.discord}">Discord</a>`);
  if (socials.website) links.push(`🌐 <a href="${socials.website}">Website</a>`);

  if (!links.length) return null;
  return `🔗 <b>Socials:</b> ${links.join(' | ')}`;
}

async function fetchCandidateMintsFromHelius() {
  const sigs = await heliusRpc('getSignaturesForAddress', [CFG.pumpProgramId, { limit: CFG.signaturesLimit }]);
  const signatures = (Array.isArray(sigs) ? sigs : [])
    .map((x) => x.signature)
    .filter(Boolean)
    .filter((s) => !processedSigSet.has(s));

  if (!signatures.length) return [];

  const mints = new Set();

  for (const sig of signatures) {
    processedSigSet.add(sig);

    const tx = await heliusRpc('getTransaction', [
      sig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]).catch(() => null);

    const balances = tx?.meta?.postTokenBalances || [];
    for (const b of balances) {
      const mint = b?.mint;
      if (!mint) continue;
      if (mint === 'So11111111111111111111111111111111111111112') continue;
      mints.add(mint);
    }
  }

  state.processedSignatures = [...processedSigSet].slice(-5000);
  saveState(state);

  return [...mints].slice(0, 25);
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
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 8);
}

async function fetchPairsByMints(mints) {
  const out = [];
  for (const mint of mints) {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    if (!r || !r.ok) continue;
    const j = await r.json().catch(() => null);
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    out.push(...pairs);
  }

  const uniq = new Map();
  for (const p of out) {
    const key = p.pairAddress || `${p.chainId}:${p.baseToken?.address}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }
  return [...uniq.values()];
}

// ─── MODIFIED: buildMessage now accepts holders + socials ───────────────────
function buildMessage(item, holders, socials) {
  const { p, mc, liq, vol, buys, sells, ratio, age } = item;
  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || '?';
  const ca = p.baseToken?.address || '-';
  const pairUrl = p.url || `https://dexscreener.com/solana/${p.pairAddress}`;

  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + (liq / 2000) + (vol / 20000))));

  const holdersBlock = formatHoldersBlock(holders);
  const socialsBlock = formatSocialsBlock(socials);

  const lines = [
    `━━━━━━━━━━━━━━━━━━`,
    `🚨 <b>JANE CALL</b> 🟢`,
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
  ];

  // Insert holders block if available
  if (holdersBlock) {
    lines.push(``);
    lines.push(holdersBlock);
  }

  // Insert socials block if available
  if (socialsBlock) {
    lines.push(``);
    lines.push(socialsBlock);
  }

  lines.push(``);
  lines.push(`📌 <b>CA</b>`);
  lines.push(`<code>${ca}</code>`);
  lines.push(`🔗 <a href="${pairUrl}">DexScreener</a>`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);

  return lines.join('\n');
}

function ensureCallTracked(item) {
  const id = item.p?.pairAddress || item.p?.baseToken?.address;
  if (!id) return null;
  if (!state.calls[id]) {
    state.calls[id] = {
      id,
      tokenAddress: item.p?.baseToken?.address || id,
      symbol: item.p?.baseToken?.symbol || '?',
      name: item.p?.baseToken?.name || 'Unknown',
      entryMcap: item.mc,
      entryPrice: toNum(item.p?.priceUsd),
      lastMilestoneHit: 1.0,
      firstSeenAt: Date.now(),
    };
    saveState(state);
  }
  return id;
}

function buildMilestoneMessage(call, nowMcap, nowPrice, multiple) {
  return [
    `━━━━━━━━━━━━━━━━━━`,
    `🚀 <b>JANE MILESTONE</b>`,
    `<b>${call.name} (${call.symbol})</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `<b>${multiple.toFixed(2)}X REACHED</b>`,
    ``,
    `Entry MCAP: ${formatUsd(call.entryMcap)}`,
    `Now MCAP: ${formatUsd(nowMcap)}`,
    `Entry Price: ${call.entryPrice ? `$${call.entryPrice}` : '-'}`,
    `Now Price: ${nowPrice ? `$${nowPrice}` : '-'}`,
    ``,
    `📌 <b>CA</b>`,
    `<code>${call.tokenAddress}</code>`,
    `━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

async function checkMilestonesAndBroadcast() {
  const callIds = Object.keys(state.calls || {});
  if (!callIds.length || !state.subscribers.length) return;

  for (const id of callIds.slice(-300)) {
    const call = state.calls[id];
    if (!call?.tokenAddress || !call?.entryMcap) continue;

    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${call.tokenAddress}`).catch(() => null);
    if (!r || !r.ok) continue;
    const j = await r.json().catch(() => null);
    const pairs = Array.isArray(j?.pairs)
      ? j.pairs.filter((p) => (p.chainId || '').toLowerCase() === CFG.chainId)
      : [];
    if (!pairs.length) continue;

    pairs.sort((a, b) => toNum(b.volume?.h24) - toNum(a.volume?.h24));
    const p = pairs[0];

    const nowMcap = toNum(p.marketCap);
    const nowPrice = toNum(p.priceUsd);
    if (nowMcap <= 0 || call.entryMcap <= 0) continue;

    const mult = nowMcap / call.entryMcap;

    const start = Math.max(1.01, CFG.startMultiple);
    const step = Math.max(0.1, CFG.stepMultiple);
    const last = Number(call.lastMilestoneHit || 1.0);

    if (last < start && mult >= start) {
      call.lastMilestoneHit = start;
      saveState(state);

      const msg = buildMilestoneMessage(call, nowMcap, nowPrice, start);
      for (const chatId of state.subscribers) {
        try {
          await sendMessage(chatId, msg);
        } catch (e) {
          console.error(`[milestone] chat ${chatId} failed:`, e.message || String(e));
        }
      }
      continue;
    }

    if (mult >= start && last >= start) {
      const next = Number((last + step).toFixed(2));
      if (mult >= next) {
        call.lastMilestoneHit = next;
        saveState(state);

        const msg = buildMilestoneMessage(call, nowMcap, nowPrice, next);
        for (const chatId of state.subscribers) {
          try {
            await sendMessage(chatId, msg);
          } catch (e) {
            console.error(`[milestone] chat ${chatId} failed:`, e.message || String(e));
          }
        }
      }
    }
  }
}

async function handleCommands() {
  const updates = await tg('getUpdates', { timeout: 50, offset });
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
      await sendMessage(
        chatId,
        `Subscribers: ${state.subscribers.length}\nSent cache: ${sentSet.size}\nProcessed tx: ${processedSigSet.size}`
      );
    }
  }
}

async function updatesLoop() {
  while (true) {
    try {
      await handleCommands();
    } catch (e) {
      console.error('[updates] error:', e.message || String(e));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function scanAndBroadcast() {
  try {
    if (state.subscribers.length === 0) return;

    const mints = await fetchCandidateMintsFromHelius();
    if (!mints.length) return;

    const pairs = await fetchPairsByMints(mints);
    const picks = pickGoodPairs(pairs);

    for (const item of picks) {
      const id = ensureCallTracked(item);
      if (!id || sentSet.has(id)) continue;

      const mintAddress = item.p?.baseToken?.address;

      // ─── NEW: Fetch holders & socials in parallel ──────────────────────
      const [holders, socialsRaw] = await Promise.all([
        mintAddress ? fetchTopHolders(mintAddress) : Promise.resolve(null),
        Promise.resolve(extractSocials(item.p)),
      ]);

      const msg = buildMessage(item, holders, socialsRaw);
      const imageUrl = socialsRaw?.imageUrl || null;

      for (const chatId of state.subscribers) {
        try {
          if (imageUrl) {
            await sendPhoto(chatId, imageUrl, msg);
          } else {
            await sendMessage(chatId, msg);
          }
        } catch (e) {
          console.error(`[broadcast] chat ${chatId} failed:`, e.message || String(e));
        }
      }

      sentSet.add(id);
      state.sent = [...sentSet].slice(-5000);
      saveState(state);
    }

    await checkMilestonesAndBroadcast();
    console.log(`[scan] subscribers=${state.subscribers.length} mints=${mints.length} pairs=${pairs.length} picks=${picks.length} sentSet=${sentSet.size} calls=${Object.keys(state.calls||{}).length}`);
  } catch (e) {
    console.error('[scan] error:', e.message || String(e));
  }
}

console.log('pump-alert unified bot (Helius source) started');
updatesLoop();
setInterval(scanAndBroadcast, CFG.pollMs);
