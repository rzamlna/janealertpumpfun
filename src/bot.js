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

function shortCa(ca = '') {
  if (!ca || ca.length < 12) return ca || '-';
  return `${ca.slice(0, 6)}...${ca.slice(-6)}`;
}

function buildTopCallMessage() {
  const calls = Object.values(state.calls || {});
  if (!calls.length) {
    return '📊 Top Call: belum ada data call.';
  }

  const ranked = calls
    .map((c) => ({
      name: c.name || 'Unknown',
      symbol: c.symbol || '?',
      // Gunakan peakMcap untuk hitung x tertinggi yang pernah dicapai
      x: c.entryMcap > 0
        ? Math.max(Number(c.lastMilestoneHit || 1), (c.peakMcap || c.entryMcap) / c.entryMcap)
        : Number(c.lastMilestoneHit || 1),
      ca: c.tokenAddress || '-',
    }))
    .sort((a, b) => b.x - a.x)
    .slice(0, 10);

  const lines = [
    '🏆 <b>TOP JANE CALL</b>',
    '',
  ];

  ranked.forEach((r, i) => {
    lines.push(`${i + 1}. <b>${r.name} (${r.symbol})</b> — <b>${r.x.toFixed(2)}x</b>`);
    lines.push(`   <code>${shortCa(r.ca)}</code>`);
  });

  return lines.join('\n');
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

async function sendMessage(chatId, text, opts = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    ...(opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
  });
}

async function sendPhoto(chatId, photoUrl, caption, opts = {}) {
  return tg('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...(opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
  });
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

async function fetchPumpFunMcap(ca) {
  try {
    const r = await fetch(`https://frontend-api.pump.fun/coins/${ca}`, {
      headers: { 'Accept': 'application/json' },
    }).catch(() => null);
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;

    // usd_market_cap adalah field utama, fallback ke market_cap * solPrice estimasi
    const mcap = toNum(j.usd_market_cap);
    const price = toNum(j.price); // harga per token dalam USD (tidak selalu ada)
    const complete = !!j.complete; // true = sudah graduated ke Raydium

    if (mcap <= 0) return null;
    return { mcap, price, complete, raw: j };
  } catch (e) {
    console.error('[fetchPumpFunMcap] error:', e.message || String(e));
    return null;
  }
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

  // persist processed signatures (trim)
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

function buildMessage(item) {
  const { p, mc, liq, vol, buys, sells, ratio, age } = item;
  const name = p.baseToken?.name || 'Unknown';
  const symbol = p.baseToken?.symbol || '?';
  const ca = p.baseToken?.address || '-';
  const pairUrl = p.url || `https://dexscreener.com/solana/${p.pairAddress}`;

  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + (liq / 2000) + (vol / 20000))));

  const website = p.info?.websites?.[0]?.url;
  const socials = Array.isArray(p.info?.socials) ? p.info.socials : [];
  const x = socials.find((s) => String(s.type).toLowerCase() === 'twitter')?.url;
  const tgLink = socials.find((s) => String(s.type).toLowerCase() === 'telegram')?.url;

  const lines = [
    `🚨 <b>JANE CALL</b> 🟢`,
    `<b>${name} (${symbol})</b>`,
    ``,
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
  ];

  if (website || x || tgLink) {
    lines.push('');
    lines.push('🌐 <b>Socials</b>');
    if (website) lines.push(`• <a href="${website}">Website</a>`);
    if (x) lines.push(`• <a href="${x}">Twitter/X</a>`);
    if (tgLink) lines.push(`• <a href="${tgLink}">Telegram</a>`);
  }

  lines.push(`🔗 <a href="${pairUrl}">DexScreener</a>`);
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
      peakMcap: item.mc, // ✅ track peak dari awal
      firstSeenAt: Date.now(),
      imageUrl: item.p?.info?.imageUrl || item.p?.info?.header || null,
      parentMessageIds: {},
    };
    saveState(state);
  }
  return id;
}

function buildMilestoneMessage(call, peakMcap, nowMcap, nowPrice, multiple) {
  const reachedMcap = call.entryMcap * multiple;
  const reachedPrice = call.entryPrice > 0 ? call.entryPrice * multiple : null;

  return [
    `🚀 <b>JANE MULTIPLE</b>`,
    `<b>${call.name} (${call.symbol})</b>`,
    `<b>${multiple.toFixed(2)}X REACHED</b>`,
    ``,
    `Entry MCAP: ${formatUsd(call.entryMcap)}`,
    `Reached MCAP: ${formatUsd(reachedMcap)}`,
    `Now MCAP: ${formatUsd(nowMcap)}`,
    `Entry Price: ${call.entryPrice ? `$${call.entryPrice}` : '-'}`,
    `Reached Price: ${reachedPrice ? `$${reachedPrice.toFixed(10).replace(/\.?0+$/, '')}` : '-'}`,
    `Now Price: ${nowPrice ? `$${nowPrice}` : '-'}`,
    ``,
    `📌 <b>CA</b>`,
    `<code>${call.tokenAddress}</code>`,
  ].join('\n');
}

async function checkMilestonesAndBroadcast() {
  const callIds = Object.keys(state.calls || {});
  if (!callIds.length || !state.subscribers.length) return;

  for (const id of callIds.slice(-300)) {
    const call = state.calls[id];
    if (!call?.tokenAddress || !call?.entryMcap) continue;

    // ✅ Cek Pump.fun dulu untuk nowMcap yang lebih akurat (bonding curve)
    // Fallback ke DexScreener kalau Pump.fun tidak return data
    let nowMcap = 0;
    let nowPrice = 0;
    let p = null;

    const pumpData = await fetchPumpFunMcap(call.tokenAddress);
    if (pumpData && pumpData.mcap > 0) {
      nowMcap = pumpData.mcap;
      nowPrice = pumpData.price || 0;
      console.log(`[pumpfun] ${call.symbol} mcap=${formatUsd(nowMcap)} graduated=${pumpData.complete}`);
    }

    // Selalu ambil DexScreener juga untuk data priceChange (m5/h1/h6/h24)
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${call.tokenAddress}`).catch(() => null);
    if (r && r.ok) {
      const j = await r.json().catch(() => null);
      const pairs = Array.isArray(j?.pairs)
        ? j.pairs.filter((px) => (px.chainId || '').toLowerCase() === CFG.chainId)
        : [];
      if (pairs.length) {
        pairs.sort((a, b) => toNum(b.volume?.h24) - toNum(a.volume?.h24));
        p = pairs[0];
        // Kalau Pump.fun tidak ada data, pakai DexScreener untuk nowMcap juga
        if (nowMcap <= 0) {
          nowMcap = toNum(p.marketCap);
          nowPrice = toNum(p.priceUsd);
        }
      }
    }

    if (nowMcap <= 0 || call.entryMcap <= 0) continue;

    // ✅ ESTIMASI PEAK dari priceChange m5, h1, h6, h24
    // Semua periode dipakai supaya ATH sebelum rug tetap bisa terdeteksi
    // Formula: kalau change negatif → peak = nowMcap / (1 + change/100)
    // Contoh: nowMcap=$10k, h6=-90% → peak 6 jam lalu = 10000/0.1 = $100k
    const m5Change  = toNum(p?.priceChange?.m5,  0);
    const h1Change  = toNum(p?.priceChange?.h1,  0);
    const h6Change  = toNum(p?.priceChange?.h6,  0);
    const h24Change = toNum(p?.priceChange?.h24, 0);

    function estPeak(nowMcap, change) {
      if (change >= 0) return nowMcap; // masih naik/flat, peak = sekarang
      const divisor = 1 + change / 100;
      if (divisor < 0.01) return nowMcap; // ekstrem, abaikan
      return nowMcap / divisor;
    }

    const peakEstM5  = estPeak(nowMcap, m5Change);
    const peakEstH1  = estPeak(nowMcap, h1Change);
    const peakEstH6  = estPeak(nowMcap, h6Change);
    const peakEstH24 = estPeak(nowMcap, h24Change);

    // ✅ UPDATE PEAK: ambil tertinggi dari semua sumber
    const prevPeak = toNum(call.peakMcap) || call.entryMcap;
    const peakMcap = Math.max(prevPeak, nowMcap, peakEstM5, peakEstH1, peakEstH6, peakEstH24);
    if (peakMcap > prevPeak) {
      call.peakMcap = peakMcap;
    }

    // ✅ GUNAKAN PEAK untuk hitung multiplier, bukan nowMcap
    const mult = peakMcap / call.entryMcap;

    const start = Math.max(1.01, CFG.startMultiple);
    const step = Math.max(0.1, CFG.stepMultiple);
    const last = Number(call.lastMilestoneHit || 1.0);

    console.log(`[milestone-check] ${call.symbol} | entry=${formatUsd(call.entryMcap)} peak=${formatUsd(peakMcap)} now=${formatUsd(nowMcap)} m5=${m5Change.toFixed(1)}% h1=${h1Change.toFixed(1)}% h6=${h6Change.toFixed(1)}% h24=${h24Change.toFixed(1)}% mult=${mult.toFixed(3)} last=${last}`);

    // First dynamic trigger from startMultiple (e.g., 1.5x)
    if (last < start && mult >= start) {
      call.lastMilestoneHit = start;
      call.peakMcap = peakMcap;
      saveState(state);

      const msg = buildMilestoneMessage(call, peakMcap, nowMcap, nowPrice, start);
      for (const chatId of state.subscribers) {
        try {
          const replyId = call.parentMessageIds?.[String(chatId)] || undefined;
          await sendMessage(chatId, msg, { replyToMessageId: replyId });
        } catch (e) {
          console.error(`[milestone] chat ${chatId} failed:`, e.message || String(e));
        }
      }
      continue;
    }

    // Next dynamic triggers every stepMultiple (e.g., +0.5x forever)
    if (mult >= start && last >= start) {
      const next = Number((last + step).toFixed(2));
      if (mult >= next) {
        call.lastMilestoneHit = next;
        call.peakMcap = peakMcap;
        saveState(state);

        const msg = buildMilestoneMessage(call, peakMcap, nowMcap, nowPrice, next);
        for (const chatId of state.subscribers) {
          try {
            const replyId = call.parentMessageIds?.[String(chatId)] || undefined;
            await sendMessage(chatId, msg, { replyToMessageId: replyId });
          } catch (e) {
            console.error(`[milestone] chat ${chatId} failed:`, e.message || String(e));
          }
        }
      }
    }

    // Simpan peakMcap meski tidak ada milestone baru
    if (peakMcap > prevPeak) {
      saveState(state);
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

    if (text === '/topcall') {
      await sendMessage(chatId, buildTopCallMessage());
    }

    // ✅ Owner manual add milestone + broadcast ke semua subscriber
    if (text.startsWith('/addmilestone') && isOwner(msg)) {
      const parts = text.split(/\s+/);
      const ca = parts[1]?.trim();
      const mult = parseFloat(parts[2]);

      if (!ca || !Number.isFinite(mult) || mult <= 1) {
        await sendMessage(chatId, '❌ Format salah. Contoh:\n<code>/addmilestone ABC123...XYZ 2.5</code>');
        continue;
      }

      // Cari call by tokenAddress atau id (pairAddress)
      const found = Object.values(state.calls).find(
        (c) => c.tokenAddress === ca || c.id === ca
      );

      if (!found) {
        await sendMessage(chatId, `❌ CA tidak ditemukan di state:\n<code>${ca}</code>\nToken harus pernah di-call dulu.`);
        continue;
      }

      const prevMilestone = found.lastMilestoneHit;

      // Ambil data harga terkini dari dexscreener
      let nowMcap = found.entryMcap * mult;
      let nowPrice = found.entryPrice * mult;
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${found.tokenAddress}`).catch(() => null);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          const pairs = Array.isArray(j?.pairs)
            ? j.pairs.filter((p) => (p.chainId || '').toLowerCase() === CFG.chainId)
            : [];
          if (pairs.length) {
            pairs.sort((a, b) => toNum(b.volume?.h24) - toNum(a.volume?.h24));
            const p = pairs[0];
            nowMcap = toNum(p.marketCap) || nowMcap;
            nowPrice = toNum(p.priceUsd) || nowPrice;
          }
        }
      } catch (_) {}

      // Update state
      found.lastMilestoneHit = mult;
      found.peakMcap = Math.max(toNum(found.peakMcap) || 0, nowMcap);
      saveState(state);

      // Konfirmasi ke owner
      await sendMessage(
        chatId,
        `✅ Milestone diupdate!\n\n` +
        `Token: <b>${found.name} (${found.symbol})</b>\n` +
        `<code>${found.tokenAddress}</code>\n\n` +
        `lastMilestoneHit: <b>${prevMilestone}x</b> → <b>${mult}x</b>\n\n` +
        `Broadcast ke ${state.subscribers.length} subscriber...`
      );

      // Broadcast notif milestone ke semua subscriber dengan format standar
      const broadcastMsg = buildMilestoneMessage(found, found.peakMcap, nowMcap, nowPrice, mult);
      for (const subscriberId of state.subscribers) {
        try {
          const replyId = found.parentMessageIds?.[String(subscriberId)] || undefined;
          await sendMessage(subscriberId, broadcastMsg, { replyToMessageId: replyId });
        } catch (e) {
          console.error(`[addmilestone] broadcast to ${subscriberId} failed:`, e.message || String(e));
        }
      }
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

      const msg = buildMessage(item);
      for (const chatId of state.subscribers) {
        try {
          let result;
          const photoUrl = state.calls[id]?.imageUrl;
          if (photoUrl) {
            result = await sendPhoto(chatId, photoUrl, msg);
          } else {
            result = await sendMessage(chatId, msg);
          }

          if (!state.calls[id].parentMessageIds) state.calls[id].parentMessageIds = {};
          if (result?.message_id) {
            state.calls[id].parentMessageIds[String(chatId)] = result.message_id;
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
