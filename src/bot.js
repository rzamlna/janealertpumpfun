import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';

const app = express();
app.use(express.json());

const CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerId: process.env.OWNER_TELEGRAM_ID || '',
  maxAgeMin: Number(process.env.MAX_AGE_MINUTES || 45),
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 10000),
  minMcap: Number(process.env.MIN_MCAP_USD || 20000),
  maxMcap: Number(process.env.MAX_MCAP_USD || 150000),
  minVol24h: Number(process.env.MIN_VOLUME_24H_USD || 100000),
  chainId: process.env.CHAIN_ID || 'solana',
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET || 'rahasia123',
  webhookPort: Number(process.env.WEBHOOK_PORT || 3000),
  webhookPath: process.env.WEBHOOK_PATH || '/helius-webhook',
  pumpProgramId: process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  startMultiple: Number(process.env.START_MULTIPLE || 1.5),
  stepMultiple: Number(process.env.STEP_MULTIPLE || 0.5),
  startAlertText: process.env.START_ALERT_TEXT || '🚨 Alert aktif! Ketik /stop untuk berhenti.',
  stateFile: process.env.STATE_FILE || './state.json',
};

if (!CFG.token) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!CFG.heliusApiKey) {
  console.error('Missing HELIUS_API_KEY');
  process.exit(1);
}

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

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function ageMinutes(ts) {
  if (!ts) return 99999;
  return (Date.now() - new Date(ts).getTime()) / 60000;
}

function formatUsd(n) {
  return `$${Math.round(n).toLocaleString()}`;
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${CFG.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed`);
  return data.result;
}

async function sendMessage(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false });
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
    return await tg('sendPhoto', { chat_id: chatId, photo: imageUrl, caption, parse_mode: 'HTML' });
  } catch {
    return sendMessage(chatId, caption);
  }
}

// HELIUS DAS
async function fetchTokenMeta(mint) {
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getAsset',
        params: { id: mint, displayOptions: { showFungible: true } }
      })
    });
    const data = await res.json();
    const asset = data.result;
    if (!asset) return null;
    return {
      mintAddress: mint,
      name: asset.content?.metadata?.name || 'Unknown',
      symbol: asset.content?.metadata?.symbol || '?',
      imageUrl: asset.content?.links?.image || null,
      twitter: asset.content?.links?.twitter || null,
      website: asset.content?.links?.external_url || null,
    };
  } catch (e) {
    console.error(`[DAS] error:`, e.message);
    return null;
  }
}

// DEXSCREENER dengan retry
async function fetchDexData(mint, maxRetries = 8, delay = 5000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const text = await res.text();
      if (text.startsWith('<')) {
        console.log(`[dex] retry ${i+1}/${maxRetries} - HTML response`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const data = JSON.parse(text);
      const pairs = (data?.pairs || []).filter(p => p.chainId?.toLowerCase() === 'solana');
      if (pairs.length === 0) {
        console.log(`[dex] retry ${i+1}/${maxRetries} - no pairs`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const best = pairs.sort((a,b) => toNum(b.volume?.h24) - toNum(a.volume?.h24))[0];
      return {
        price: toNum(best.priceUsd),
        marketCap: toNum(best.marketCap),
        liquidity: toNum(best.liquidity?.usd),
        volume24h: toNum(best.volume?.h24),
        priceChange24h: toNum(best.priceChange?.h24),
        buys1h: toNum(best.txns?.h1?.buys),
        sells1h: toNum(best.txns?.h1?.sells),
        age: ageMinutes(best.pairCreatedAt),
        pairUrl: best.url || `https://dexscreener.com/solana/${best.pairAddress}`,
      };
    } catch (e) {
      console.log(`[dex] retry ${i+1}/${maxRetries} - error`);
      if (i === maxRetries-1) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

async function fetchTopHolders(mint) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/token-accounts?api-key=${CFG.heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [mint], includeNativeBalance: false })
    });
    const accounts = await res.json();
    const totalSupply = accounts.reduce((s, a) => s + toNum(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount), 0);
    if (totalSupply <= 0) return null;
    const sorted = accounts.map(a => ({
      owner: a.account?.data?.parsed?.info?.owner || a.owner,
      amount: toNum(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount)
    })).filter(a => a.amount > 0).sort((a,b) => b.amount - a.amount).slice(0,10);
    return sorted.map((a,i) => ({ rank: i+1, owner: a.owner, pct: ((a.amount/totalSupply)*100).toFixed(2) }));
  } catch { return null; }
}

function formatHolders(holders) {
  if (!holders?.length) return null;
  const top3 = holders.slice(0,3).reduce((s,h) => s + parseFloat(h.pct), 0);
  const top10 = holders.reduce((s,h) => s + parseFloat(h.pct), 0);
  const rows = holders.map(h => {
    const short = `${h.owner.slice(0,4)}...${h.owner.slice(-4)}`;
    return `  ${h.rank}. <code>${short}</code> — ${h.pct}%`;
  }).join('\n');
  return `👥 <b>Top 10 Holders</b>\n${rows}\n• Top 3: ${top3.toFixed(2)}% | Top 10: ${top10.toFixed(2)}%`;
}

function buildMessage(meta, dex, holders) {
  const ratio = dex?.sells1h > 0 ? dex.buys1h / dex.sells1h : dex?.buys1h || 0;
  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + ((dex?.liquidity||0)/2000) + ((dex?.volume24h||0)/20000))));
  const lines = [
    `━━━━━━━━━━━━━━━━━━`,
    `🚨 <b>JANE CALL</b> 🟢`,
    `<b>${meta.name} (${meta.symbol})</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💵 <b>Price:</b> ${dex?.price ? `$${dex.price.toFixed(8)}` : '-'}`,
    `📈 <b>24H:</b> ${dex?.priceChange24h?.toFixed(2) || 0}%`,
    `⭐ <b>Score:</b> ${score}/100`,
    ``,
    `📊 <b>Metrics</b>`,
    `• MCAP: ${formatUsd(dex?.marketCap || 0)}`,
    `• LIQ: ${formatUsd(dex?.liquidity || 0)}`,
    `• VOL 24H: ${formatUsd(dex?.volume24h || 0)}`,
    `• Age: ${dex?.age?.toFixed(1) || 0}m`,
    ``,
    `🧾 <b>Flow</b>`,
    `• 1H Buys/Sells: ${dex?.buys1h || 0}/${dex?.sells1h || 0} (ratio ${ratio.toFixed(2)})`,
  ];
  const holdersBlock = formatHolders(holders);
  if (holdersBlock) lines.push(``, holdersBlock);
  const socials = [];
  if (meta.twitter) socials.push(`🐦 <a href="${meta.twitter}">Twitter</a>`);
  if (meta.website) socials.push(`🌐 <a href="${meta.website}">Website</a>`);
  if (socials.length) lines.push(``, `🔗 <b>Socials:</b> ${socials.join(' | ')}`);
  lines.push(``, `📌 <b>CA</b>`, `<code>${meta.mintAddress}</code>`, `🔗 <a href="${dex?.pairUrl || `https://dexscreener.com/solana/${meta.mintAddress}`}">DexScreener</a>`, `━━━━━━━━━━━━━━━━━━`);
  return lines.join('\n');
}

function trackCall(mint, meta, dex) {
  if (!state.calls[mint]) {
    state.calls[mint] = {
      id: mint,
      tokenAddress: mint,
      symbol: meta.symbol,
      name: meta.name,
      entryMcap: dex?.marketCap || 0,
      entryPrice: dex?.price || 0,
      lastMilestoneHit: 1.0,
      firstSeenAt: Date.now(),
      messageIds: {},
    };
    saveState(state);
  }
  return mint;
}

// MILESTONE
async function checkMilestonesAndBroadcast() {
  const callIds = Object.keys(state.calls || {});
  if (!callIds.length || !state.subscribers.length) return;

  for (const id of callIds.slice(-300)) {
    const call = state.calls[id];
    if (!call?.tokenAddress || !call?.entryMcap) continue;

    const dexData = await fetchDexData(call.tokenAddress, 3, 3000);
    if (!dexData) continue;

    const nowMcap = dexData.marketCap;
    const nowPrice = dexData.price;
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
          const replyToId = call.messageIds?.[String(chatId)];
          if (replyToId) await sendReply(chatId, msg, replyToId);
          else await sendMessage(chatId, msg);
        } catch (e) { console.error(`[milestone] ${chatId}:`, e.message); }
      }
    } else if (mult >= start && last >= start) {
      const next = Number((last + step).toFixed(2));
      if (mult >= next) {
        call.lastMilestoneHit = next;
        saveState(state);
        const msg = buildMilestoneMessage(call, nowMcap, nowPrice, next);
        for (const chatId of state.subscribers) {
          try {
            const replyToId = call.messageIds?.[String(chatId)];
            if (replyToId) await sendReply(chatId, msg, replyToId);
            else await sendMessage(chatId, msg);
          } catch (e) { console.error(`[milestone] ${chatId}:`, e.message); }
        }
      }
    }
  }
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

// WEBHOOK HANDLER
app.post(CFG.webhookPath, async (req, res) => {
  console.log('[webhook] request received');
  const txs = req.body;
  if (!Array.isArray(txs) || !txs.length) return res.status(200).send('OK');
  
  console.log(`[webhook] received ${txs.length} txs`);
  const mints = new Set();
  for (const tx of txs) {
    for (const bal of (tx?.meta?.postTokenBalances || [])) {
      const mint = bal?.mint;
      if (mint && !sentSet.has(mint)) mints.add(mint);
    }
  }
  if (!mints.size) return res.status(200).send('OK');
  console.log(`[webhook] found ${mints.size} new mints`);

  const blacklist = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'];
  
  for (const mint of mints) {
    try {
      if (blacklist.includes(mint)) continue;
      
      console.log(`[DAS] fetching ${mint}`);
      const meta = await fetchTokenMeta(mint);
      if (!meta) continue;
      console.log(`[DAS] ${meta.name} (${meta.symbol})`);
      
      console.log(`[dex] waiting for data...`);
      const dex = await fetchDexData(mint, 8, 5000);
      if (!dex) continue;
      
      if (dex.age > CFG.maxAgeMin) { console.log(`[skip] age ${dex.age.toFixed(1)}m`); continue; }
      if (dex.liquidity < CFG.minLiquidity) { console.log(`[skip] liq ${formatUsd(dex.liquidity)}`); continue; }
      if (dex.marketCap < CFG.minMcap || dex.marketCap > CFG.maxMcap) { console.log(`[skip] mcap ${formatUsd(dex.marketCap)}`); continue; }
      if (dex.volume24h < CFG.minVol24h) { console.log(`[skip] vol ${formatUsd(dex.volume24h)}`); continue; }
      
      const holders = await fetchTopHolders(mint);
      const msg = buildMessage(meta, dex, holders);
      const callId = trackCall(mint, meta, dex);
      
      for (const chatId of state.subscribers) {
        try {
          const result = meta.imageUrl ? await sendPhoto(chatId, meta.imageUrl, msg) : await sendMessage(chatId, msg);
          if (result?.message_id && callId) {
            if (!state.calls[callId].messageIds) state.calls[callId].messageIds = {};
            state.calls[callId].messageIds[String(chatId)] = result.message_id;
          }
        } catch (e) { console.error(`[broadcast] ${chatId}:`, e.message); }
      }
      
      sentSet.add(mint);
      state.sent = [...sentSet].slice(-5000);
      saveState(state);
      console.log(`[sent] ✅ ${meta.name} - ${formatUsd(dex.marketCap)}`);
      
    } catch (e) { console.error(`[process] ${mint}:`, e.message); }
  }
  res.status(200).send('OK');
});

// TELEGRAM WEBHOOK
app.post('/telegram-webhook', async (req, res) => {
  res.status(200).send('OK');
  const msg = req.body.message;
  if (!msg?.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  if (text === '/start') {
    if (!state.subscribers.includes(chatId)) state.subscribers.push(chatId);
    saveState(state);
    await sendMessage(chatId, CFG.startAlertText);
  }
  if (text === '/stop') {
    state.subscribers = state.subscribers.filter(id => id !== chatId);
    saveState(state);
    await sendMessage(chatId, '🛑 Unsubscribed');
  }
  if (text === '/status' && String(msg.from?.id) === String(CFG.ownerId)) {
    await sendMessage(chatId, `Subscribers: ${state.subscribers.length}\nSent: ${sentSet.size}\nCalls: ${Object.keys(state.calls).length}`);
  }
});

async function registerHeliusWebhook() {
  const url = `${process.env.PUBLIC_URL}${CFG.webhookPath}`;
  try {
    const list = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${CFG.heliusApiKey}`);
    const webhooks = await list.json();
    for (const w of webhooks) {
      if (w.webhookURL === url) {
        await fetch(`https://api.helius.xyz/v0/webhooks/${w.webhookID}?api-key=${CFG.heliusApiKey}`, { method: 'DELETE' });
      }
    }
  } catch {}
  await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${CFG.heliusApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: url,
      transactionTypes: ['ANY'],
      accountAddresses: [CFG.pumpProgramId],
      webhookType: 'raw',
    })
  });
  console.log('[webhook] registered');
}

async function setTelegramWebhook() {
  const url = `${process.env.PUBLIC_URL}/telegram-webhook`;
  await tg('deleteWebhook', {});
  await tg('setWebhook', { url, allowed_updates: ['message'] });
  console.log('[telegram] webhook set');
}

app.listen(CFG.webhookPort, async () => {
  console.log('========================================');
  console.log('🚀 PUMP ALERT BOT - WEBHOOK MODE');
  console.log('========================================');
  await registerHeliusWebhook();
  await setTelegramWebhook();
  
  // Milestone checker setiap 60 detik
  setInterval(checkMilestonesAndBroadcast, 60000);
  
  console.log('✅ Bot ready!');
  console.log('   ✓ Milestone tracking aktif (cek setiap 60 detik)');
});
