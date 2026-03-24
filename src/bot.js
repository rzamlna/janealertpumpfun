import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerId: process.env.OWNER_TELEGRAM_ID || '',

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
  startMultiple: Number(process.env.START_MULTIPLE || 2),
  stepMultiple: Number(process.env.STEP_MULTIPLE || 0.5),

  // Webhook server
  webhookPort: Number(process.env.WEBHOOK_PORT || 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Milestone check interval (tiap 30 detik)
  milestoneMs: Number(process.env.MILESTONE_INTERVAL_MS || 30000),

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

const HELIUS_RPC = CFG.heliusRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`;
const HELIUS_API_BASE = `https://api.helius.xyz/v0`;

// ─── State ────────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = fs.readFileSync(CFG.stateFile, 'utf8');
    const s = JSON.parse(raw);
    s.subscribers = Array.isArray(s.subscribers) ? s.subscribers : [];
    s.sent = Array.isArray(s.sent) ? s.sent : [];
    s.calls = s.calls && typeof s.calls === 'object' ? s.calls : {};
    return s;
  } catch {
    return { subscribers: [], sent: [], calls: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
}

const state = loadState();
const sentSet = new Set(state.sent);
const scannedMintSet = new Set();
let offset = 0;

// ─── Blacklist mint ───────────────────────────────────────────────────────────
const BLACKLIST_MINTS = new Set([
  'So11111111111111111111111111111111111111112',    // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Telegram ─────────────────────────────────────────────────────────────────
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

async function sendReply(chatId, text, replyToMessageId) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
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
    console.warn(`[sendPhoto] fallback to sendMessage for chat ${chatId}:`, e.message || String(e));
    return sendMessage(chatId, caption);
  }
}

// ─── Helius RPC ───────────────────────────────────────────────────────────────
async function heliusRpc(method, params) {
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} rpc error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ─── Top 10 Holders ───────────────────────────────────────────────────────────
async function fetchTopHolders(mintAddress) {
  try {
    const url = `${HELIUS_API_BASE}/token-accounts?api-key=${CFG.heliusApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [mintAddress], includeNativeBalance: false, displayOptions: {} }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const accounts = Array.isArray(json) ? json : [];
    const totalSupply = accounts.reduce((sum, a) => sum + toNum(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount), 0);
    if (totalSupply <= 0) return null;
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
      pct: ((a.amount / totalSupply) * 100).toFixed(2),
    }));
  } catch (e) {
    console.error('[fetchTopHolders] error:', e.message || String(e));
    return null;
  }
}

// ─── Socials ──────────────────────────────────────────────────────────────────
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
  if (websites.length > 0 && websites[0].url) result.website = websites[0].url;
  result.imageUrl = info.imageUrl || null;
  return result;
}

function formatHoldersBlock(holders) {
  if (!holders || !holders.length) return null;
  const top3Pct = holders.slice(0, 3).reduce((sum, h) => sum + parseFloat(h.pct), 0);
  const top10Pct = holders.reduce((sum, h) => sum + parseFloat(h.pct), 0);
  const rows = holders
    .map((h) => `  ${h.rank}. <code>${h.owner.slice(0, 4)}...${h.owner.slice(-4)}</code> — ${h.pct}%`)
    .join('\n');
  return [`👥 <b>Top 10 Holders</b>`, rows, `• Top 3: ${top3Pct.toFixed(2)}% | Top 10: ${top10Pct.toFixed(2)}%`].join('\n');
}

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

// ─── DexScreener ──────────────────────────────────────────────────────────────
async function fetchPairsByMints(mints) {
  const results = await Promise.all(
    mints.map((mint) =>
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null)
    )
  );
  const out = [];
  for (const j of results) {
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

// ─── Filter ───────────────────────────────────────────────────────────────────
function pickGoodPairs(pairs) {
  const solana = pairs.filter((p) => (p.chainId || '').toLowerCase() === CFG.chainId);
  const mapped = solana.map((p) => {
    const mc = toNum(p.marketCap);
    const liq = toNum(p.liquidity?.usd);
    const vol = toNum(p.volume?.h24);
    const buys = toNum(p.txns?.h1?.buys);
    const sells = toNum(p.txns?.h1?.sells);
    const ratio = sells > 0 ? buys / sells : buys;
    const age = ageMinutes(p.pairCreatedAt);
    return { p, mc, liq, vol, buys, sells, ratio, age };
  });

  let passed = mapped;
  passed = passed.filter((x) => { const ok = x.age <= CFG.maxAgeMin; if (!ok) console.log(`[drop-age] ${x.p.baseToken?.symbol} age=${x.age.toFixed(1)}m`); return ok; });
  passed = passed.filter((x) => { const ok = x.liq >= CFG.minLiquidity; if (!ok) console.log(`[drop-liq] ${x.p.baseToken?.symbol} liq=$${x.liq}`); return ok; });
  passed = passed.filter((x) => { const ok = x.mc >= CFG.minMcap && x.mc <= CFG.maxMcap; if (!ok) console.log(`[drop-mc] ${x.p.baseToken?.symbol} mc=$${x.mc}`); return ok; });
  passed = passed.filter((x) => { const ok = x.vol >= CFG.minVol24h; if (!ok) console.log(`[drop-vol] ${x.p.baseToken?.symbol} vol=$${x.vol}`); return ok; });

  console.log(`[filter] solana=${solana.length} passed=${passed.length}`);
  return passed.sort((a, b) => b.vol - a.vol).slice(0, 8);
}

// ─── Build messages ───────────────────────────────────────────────────────────
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

  if (holdersBlock) { lines.push(``); lines.push(holdersBlock); }
  if (socialsBlock) { lines.push(``); lines.push(socialsBlock); }

  lines.push(``);
  lines.push(`📌 <b>CA</b>`);
  lines.push(`<code>${ca}</code>`);
  lines.push(`🔗 <a href="${pairUrl}">DexScreener</a>`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);

  return lines.join('\n');
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

// ─── Track & Broadcast ────────────────────────────────────────────────────────
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
      messageIds: {},
    };
    saveState(state);
  }
  return id;
}

async function processAndBroadcast(mints) {
  if (!mints.length || state.subscribers.length === 0) return;

  const pairs = await fetchPairsByMints(mints);
  const picks = pickGoodPairs(pairs);

  for (const item of picks) {
    const id = ensureCallTracked(item);
    if (!id || sentSet.has(id)) continue;

    const mintAddress = item.p?.baseToken?.address;
    const [holders, socialsRaw] = await Promise.all([
      mintAddress ? fetchTopHolders(mintAddress) : Promise.resolve(null),
      Promise.resolve(extractSocials(item.p)),
    ]);

    const msg = buildMessage(item, holders, socialsRaw);
    const imageUrl = socialsRaw?.imageUrl || null;

    for (const chatId of state.subscribers) {
      try {
        let result;
        if (imageUrl) {
          result = await sendPhoto(chatId, imageUrl, msg);
        } else {
          result = await sendMessage(chatId, msg);
        }
        if (result?.message_id) {
          if (!state.calls[id].messageIds) state.calls[id].messageIds = {};
          state.calls[id].messageIds[String(chatId)] = result.message_id;
        }
      } catch (e) {
        console.error(`[broadcast] chat ${chatId} failed:`, e.message || String(e));
      }
    }

    sentSet.add(id);
    state.sent = [...sentSet].slice(-5000);
    saveState(state);
    console.log(`[call] ${item.p.baseToken?.symbol} mc=$${item.mc} liq=$${item.liq} vol=$${item.vol}`);
  }
}

// ─── Milestone checker ────────────────────────────────────────────────────────
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

    let targetMultiple = null;
    if (last < start && mult >= start) {
      targetMultiple = start;
    } else if (mult >= start && last >= start) {
      const next = Number((last + step).toFixed(2));
      if (mult >= next) targetMultiple = next;
    }

    if (targetMultiple !== null) {
      call.lastMilestoneHit = targetMultiple;
      saveState(state);
      const msg = buildMilestoneMessage(call, nowMcap, nowPrice, targetMultiple);
      for (const chatId of state.subscribers) {
        try {
          const replyToId = call.messageIds?.[String(chatId)];
          if (replyToId) {
            await sendReply(chatId, msg, replyToId);
          } else {
            await sendMessage(chatId, msg);
          }
        } catch (e) {
          console.error(`[milestone] chat ${chatId} failed:`, e.message || String(e));
        }
      }
    }
  }
}

// ─── Webhook HTTP server ──────────────────────────────────────────────────────
function startWebhookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Validasi secret header
    if (CFG.webhookSecret) {
      const authHeader = req.headers['x-helius-auth'] || '';
      if (authHeader !== CFG.webhookSecret) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      // Langsung balas 200 ke Helius biar tidak timeout
      res.writeHead(200);
      res.end('OK');

      try {
        const payload = JSON.parse(body);
        const events = Array.isArray(payload) ? payload : [payload];
        const mints = new Set();

        for (const event of events) {
          // Enhanced webhook: ambil mint dari tokenTransfers
          const transfers = event?.tokenTransfers || [];
          for (const t of transfers) {
            const mint = t?.mint;
            if (!mint) continue;
            if (BLACKLIST_MINTS.has(mint)) continue;
            if (scannedMintSet.has(mint)) continue;
            mints.add(mint);
          }

          // Fallback: ambil dari accountData
          const accountData = event?.accountData || [];
          for (const a of accountData) {
            const tokenBalances = a?.tokenBalanceChanges || [];
            for (const tb of tokenBalances) {
              const mint = tb?.mint;
              if (!mint) continue;
              if (BLACKLIST_MINTS.has(mint)) continue;
              if (scannedMintSet.has(mint)) continue;
              mints.add(mint);
            }
          }
        }

        // Tandai sebagai sudah discan
        for (const mint of mints) scannedMintSet.add(mint);
        if (scannedMintSet.size > 10000) {
          const arr = [...scannedMintSet];
          arr.slice(0, arr.length - 10000).forEach((m) => scannedMintSet.delete(m));
        }

        if (mints.size > 0) {
          console.log(`[webhook] ${events.length} events, new mints=${mints.size}`);
          await processAndBroadcast([...mints]);
        }
      } catch (e) {
        console.error('[webhook] error:', e.message || String(e));
      }
    });
  });

  server.listen(CFG.webhookPort, () => {
    console.log(`[webhook] listening on port ${CFG.webhookPort}`);
  });
}

// ─── Telegram command loop ────────────────────────────────────────────────────
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
        `Subscribers: ${state.subscribers.length}\nSent cache: ${sentSet.size}\nCalls tracked: ${Object.keys(state.calls).length}\nScanned mints: ${scannedMintSet.size}`
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

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('pump-alert bot (webhook mode) started');
startWebhookServer();
updatesLoop();
setInterval(checkMilestonesAndBroadcast, CFG.milestoneMs);
