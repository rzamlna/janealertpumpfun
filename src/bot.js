import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';

const app = express();
app.use(express.json());

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

  // Helius Webhook
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET || 'rahasia123',
  webhookPort: Number(process.env.WEBHOOK_PORT || 3000),
  webhookPath: process.env.WEBHOOK_PATH || '/helius-webhook',
  
  pumpProgramId: process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // Milestone
  startMultiple: Number(process.env.START_MULTIPLE || 1.5),
  stepMultiple: Number(process.env.STEP_MULTIPLE || 0.5),

  // Bot behavior
  startAlertText: process.env.START_ALERT_TEXT ||
    '🚨 Alert aktif! Kamu sudah subscribe alert token. Ketik /stop untuk berhenti.\n\n' +
    '📋 <b>Perintah:</b>\n' +
    '/start - Mulai alert\n' +
    '/stop - Berhenti alert\n' +
    '/status - Lihat status bot\n' +
    '/watchlist - Lihat token yang dipantau',
  
  stateFile: process.env.STATE_FILE || './state.json',
};

if (!CFG.token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}
if (!CFG.heliusApiKey) {
  console.error('Missing HELIUS_API_KEY in .env');
  process.exit(1);
}

// State management
function loadState() {
  try {
    const raw = fs.readFileSync(CFG.stateFile, 'utf8');
    const s = JSON.parse(raw);
    s.subscribers = Array.isArray(s.subscribers) ? s.subscribers : [];
    s.sent = Array.isArray(s.sent) ? s.sent : [];
    s.calls = s.calls && typeof s.calls === 'object' ? s.calls : {};
    s.watchlist = s.watchlist && typeof s.watchlist === 'object' ? s.watchlist : {};
    return s;
  } catch {
    return { subscribers: [], sent: [], calls: {}, watchlist: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
}

const state = loadState();
const sentSet = new Set(state.sent);

// Helper functions
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

// Telegram API
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
    console.warn(`[sendPhoto] fallback:`, e.message);
    return sendMessage(chatId, caption);
  }
}

// ============ HELIUS DAS API (AMBIL DATA TOKEN LANGSUNG) ============
async function fetchTokenMetadataFromHelius(mintAddress) {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${CFG.heliusApiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getAsset',
        params: { 
          id: mintAddress,
          displayOptions: {
            showFungible: true,
            showNativeBalance: false
          }
        }
      })
    });
    
    const data = await response.json();
    const asset = data.result;
    
    if (!asset) {
      return null;
    }
    
    const metadata = asset.content?.metadata || {};
    const links = asset.content?.links || {};
    
    return {
      name: metadata.name || 'Unknown',
      symbol: metadata.symbol || '?',
      imageUrl: links.image || null,
      website: links.external_url || null,
      twitter: links.twitter || null,
      telegram: links.telegram || null,
      description: metadata.description || '',
      decimals: asset.token_info?.decimals || 9,
      supply: Number(asset.supply?.amount || 0),
      owner: asset.ownership?.owner || null,
      mintAddress: mintAddress
    };
  } catch (e) {
    console.error(`[DAS] error:`, e.message);
    return null;
  }
}

// ============ DEXSCREENER DENGAN RETRY ============
async function fetchDexScreenerWithRetry(mintAddress, maxRetries = 5, delayMs = 4000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
      const text = await res.text();
      
      if (text.trim().startsWith('<')) {
        console.log(`[dex] ${mintAddress} - HTML response, retry ${i+1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      const data = JSON.parse(text);
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      
      if (pairs.length === 0) {
        console.log(`[dex] ${mintAddress} - no pairs yet, retry ${i+1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      // Filter Solana pairs
      const solanaPairs = pairs.filter(p => (p.chainId || '').toLowerCase() === 'solana');
      if (solanaPairs.length === 0) {
        console.log(`[dex] ${mintAddress} - no Solana pairs`);
        return null;
      }
      
      const bestPair = solanaPairs.sort((a, b) => toNum(b.volume?.h24) - toNum(a.volume?.h24))[0];
      
      return {
        pair: bestPair,
        price: toNum(bestPair.priceUsd),
        marketCap: toNum(bestPair.marketCap),
        liquidity: toNum(bestPair.liquidity?.usd),
        volume24h: toNum(bestPair.volume?.h24),
        priceChange24h: toNum(bestPair.priceChange?.h24),
        buys1h: toNum(bestPair.txns?.h1?.buys),
        sells1h: toNum(bestPair.txns?.h1?.sells),
        age: ageMinutes(bestPair.pairCreatedAt),
        pairUrl: bestPair.url || `https://dexscreener.com/solana/${bestPair.pairAddress}`,
        socials: extractSocials(bestPair)
      };
      
    } catch (e) {
      console.log(`[dex] ${mintAddress} - error: ${e.message}, retry ${i+1}/${maxRetries}`);
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

// Register webhook ke Helius
async function registerHeliusWebhook() {
  const webhookUrl = `${process.env.PUBLIC_URL}${CFG.webhookPath}`;
  
  try {
    const listRes = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${CFG.heliusApiKey}`);
    const webhooks = await listRes.json();
    for (const webhook of webhooks) {
      if (webhook.webhookURL === webhookUrl) {
        await fetch(`https://api.helius.xyz/v0/webhooks/${webhook.webhookID}?api-key=${CFG.heliusApiKey}`, {
          method: 'DELETE',
        });
        console.log('[webhook] deleted existing webhook');
      }
    }
  } catch (e) {
    console.log('[webhook] no existing webhook found');
  }

  const payload = {
    webhookURL: webhookUrl,
    transactionTypes: ['ANY'],
    accountAddresses: [CFG.pumpProgramId],
    webhookType: 'raw',
    authHeader: CFG.heliusWebhookSecret,
  };

  try {
    const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${CFG.heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await res.json();
    console.log('[webhook] registered successfully:', data);
    return data;
  } catch (e) {
    console.error('[webhook] registration failed:', e.message);
    return null;
  }
}

// Fetch top holders via Helius API
async function fetchTopHolders(mintAddress) {
  try {
    const url = `https://api.helius.xyz/v0/token-accounts?api-key=${CFG.heliusApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mintAccounts: [mintAddress],
        includeNativeBalance: false,
      }),
    });

    if (!res.ok) return null;
    const accounts = await res.json();
    
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
      pct: totalSupply > 0 ? ((a.amount / totalSupply) * 100).toFixed(2) : '0.00',
    }));
  } catch (e) {
    console.error('[holders] error:', e.message);
    return null;
  }
}

// Extract social links
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
  result.imageUrl = info.imageUrl || null;
  return result;
}

// Format top holders block
function formatHoldersBlock(holders) {
  if (!holders || !holders.length) return null;

  const top3Pct = holders.slice(0, 3).reduce((sum, h) => sum + parseFloat(h.pct), 0);
  const top10Pct = holders.reduce((sum, h) => sum + parseFloat(h.pct), 0);

  const rows = holders.map(h => {
    const shortOwner = `${h.owner.slice(0, 4)}...${h.owner.slice(-4)}`;
    return `  ${h.rank}. <code>${shortOwner}</code> — ${h.pct}%`;
  }).join('\n');

  return [`👥 <b>Top 10 Holders</b>`, rows, `• Top 3: ${top3Pct.toFixed(2)}% | Top 10: ${top10Pct.toFixed(2)}%`].join('\n');
}

// Format socials block
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

// Build message dari data DAS + DexScreener
function buildMessageFromData(tokenMeta, dexData, holders) {
  const name = tokenMeta.name;
  const symbol = tokenMeta.symbol;
  const ca = tokenMeta.mintAddress;
  
  const price = dexData?.price || 0;
  const marketCap = dexData?.marketCap || 0;
  const liquidity = dexData?.liquidity || 0;
  const volume24h = dexData?.volume24h || 0;
  const priceChange24h = dexData?.priceChange24h || 0;
  const buys1h = dexData?.buys1h || 0;
  const sells1h = dexData?.sells1h || 0;
  const age = dexData?.age || 0;
  const pairUrl = dexData?.pairUrl || `https://dexscreener.com/solana/${ca}`;
  
  const ratio = sells1h > 0 ? buys1h / sells1h : buys1h;
  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + (liquidity / 2000) + (volume24h / 20000))));
  
  const holdersBlock = formatHoldersBlock(holders);
  
  // Gabungkan socials dari DAS dan DexScreener
  const allSocials = {
    twitter: tokenMeta.twitter || dexData?.socials?.twitter,
    telegram: tokenMeta.telegram || dexData?.socials?.telegram,
    website: tokenMeta.website || dexData?.socials?.website,
    discord: dexData?.socials?.discord
  };
  const socialsBlock = formatSocialsBlock(allSocials);
  
  const lines = [
    `━━━━━━━━━━━━━━━━━━`,
    `🚨 <b>JANE CALL</b> 🟢`,
    `<b>${name} (${symbol})</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💵 <b>Price:</b> ${price > 0 ? `$${price.toFixed(8)}` : '-'}`,
    `📈 <b>24H:</b> ${priceChange24h.toFixed(2)}%`,
    `⭐ <b>Score:</b> ${score}/100`,
    ``,
    `📊 <b>Metrics</b>`,
    `• MCAP: ${formatUsd(marketCap)}`,
    `• LIQ: ${formatUsd(liquidity)}`,
    `• VOL 24H: ${formatUsd(volume24h)}`,
    `• Age: ${age.toFixed(1)}m`,
    ``,
    `🧾 <b>Flow</b>`,
    `• 1H Buys/Sells: ${buys1h}/${sells1h} (ratio ${ratio.toFixed(2)})`,
  ];
  
  if (holdersBlock) lines.push(``, holdersBlock);
  if (socialsBlock) lines.push(``, socialsBlock);
  
  lines.push(``, `📌 <b>CA</b>`, `<code>${ca}</code>`, `🔗 <a href="${pairUrl}">DexScreener</a>`, `━━━━━━━━━━━━━━━━━━`);
  
  return lines.join('\n');
}

// Track call untuk milestone
function ensureCallTracked(mintAddress, tokenMeta, dexData) {
  const id = mintAddress;
  if (!id) return null;
  
  if (!state.calls[id]) {
    state.calls[id] = {
      id,
      tokenAddress: mintAddress,
      symbol: tokenMeta.symbol,
      name: tokenMeta.name,
      entryMcap: dexData?.marketCap || 0,
      entryPrice: dexData?.price || 0,
      lastMilestoneHit: 1.0,
      firstSeenAt: Date.now(),
      messageIds: {},
    };
    saveState(state);
  }
  return id;
}

// Milestone message
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

// Check milestones
async function checkMilestonesAndBroadcast() {
  const callIds = Object.keys(state.calls || {});
  if (!callIds.length || !state.subscribers.length) return;

  for (const id of callIds.slice(-300)) {
    const call = state.calls[id];
    if (!call?.tokenAddress || !call?.entryMcap) continue;

    const dexData = await fetchDexScreenerWithRetry(call.tokenAddress, 3, 3000);
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

// ============ WEBHOOK HANDLER ============
app.post(CFG.webhookPath, async (req, res) => {
  // SKIP SIGNATURE CHECK untuk testing
  console.log('[webhook] request received');
  
  const transactions = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(200).send('OK');
  }

  console.log(`[webhook] received ${transactions.length} transactions`);
  
  const mints = new Set();
  for (const tx of transactions) {
    const tokenBalances = tx?.meta?.postTokenBalances || [];
    for (const balance of tokenBalances) {
      const mint = balance?.mint;
      if (mint && !sentSet.has(mint)) {
        mints.add(mint);
      }
    }
  }

  if (mints.size === 0) {
    return res.status(200).send('OK');
  }

  console.log(`[webhook] found ${mints.size} new mints:`, [...mints]);

  // BLACKLIST
  const blacklist = [
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ];

  for (const mintAddress of mints) {
    try {
      if (blacklist.includes(mintAddress)) {
        console.log(`[skip] ${mintAddress} - blacklisted`);
        continue;
      }
      
      // STEP 1: Ambil metadata dari Helius DAS (cepat, real-time)
      console.log(`[DAS] fetching metadata for ${mintAddress}`);
      const tokenMeta = await fetchTokenMetadataFromHelius(mintAddress);
      
      if (!tokenMeta) {
        console.log(`[skip] ${mintAddress} - metadata not found`);
        continue;
      }
      
      console.log(`[DAS] got token: ${tokenMeta.name} (${tokenMeta.symbol})`);
      
      // STEP 2: Ambil data harga dari DexScreener (dengan retry)
      console.log(`[dex] waiting for DexScreener data...`);
      const dexData = await fetchDexScreenerWithRetry(mintAddress, 6, 5000);
      
      // STEP 3: Filter berdasarkan kriteria
      if (dexData) {
        if (dexData.age > CFG.maxAgeMin) {
          console.log(`[skip] ${tokenMeta.symbol} - age ${dexData.age.toFixed(1)}m > ${CFG.maxAgeMin}m`);
          continue;
        }
        if (dexData.liquidity < CFG.minLiquidity) {
          console.log(`[skip] ${tokenMeta.symbol} - liq ${formatUsd(dexData.liquidity)} < ${formatUsd(CFG.minLiquidity)}`);
          continue;
        }
        if (dexData.marketCap < CFG.minMcap || dexData.marketCap > CFG.maxMcap) {
          console.log(`[skip] ${tokenMeta.symbol} - mcap ${formatUsd(dexData.marketCap)} out of range`);
          continue;
        }
        if (dexData.volume24h < CFG.minVol24h) {
          console.log(`[skip] ${tokenMeta.symbol} - vol ${formatUsd(dexData.volume24h)} < ${formatUsd(CFG.minVol24h)}`);
          continue;
        }
      } else {
        console.log(`[skip] ${tokenMeta.symbol} - no DexScreener data yet`);
        continue;
      }
      
      // STEP 4: Fetch holders
      const holders = await fetchTopHolders(mintAddress);
      
      // STEP 5: Build dan kirim message
      const msg = buildMessageFromData(tokenMeta, dexData, holders);
      const imageUrl = tokenMeta.imageUrl || dexData?.socials?.imageUrl || null;
      
      const callId = ensureCallTracked(mintAddress, tokenMeta, dexData);
      
      for (const chatId of state.subscribers) {
        try {
          let result;
          if (imageUrl) {
            result = await sendPhoto(chatId, imageUrl, msg);
          } else {
            result = await sendMessage(chatId, msg);
          }
          
          if (result?.message_id && callId) {
            if (!state.calls[callId].messageIds) state.calls[callId].messageIds = {};
            state.calls[callId].messageIds[String(chatId)] = result.message_id;
          }
        } catch (e) {
          console.error(`[broadcast] chat ${chatId} failed:`, e.message);
        }
      }
      
      sentSet.add(mintAddress);
      state.sent = [...sentSet].slice(-5000);
      saveState(state);
      
      console.log(`[sent] ✅ ${tokenMeta.name} (${tokenMeta.symbol}) - MCAP: ${formatUsd(dexData.marketCap)}`);
      
    } catch (e) {
      console.error(`[process] ${mintAddress} error:`, e.message);
    }
  }
  
  res.status(200).send('OK');
});

// ============ TELEGRAM WEBHOOK ============
app.post('/telegram-webhook', async (req, res) => {
  const update = req.body;
  res.status(200).send('OK');
  
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;
  
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
  
  if (text === '/status') {
    const isOwner = String(msg.from?.id) === String(CFG.ownerId);
    if (isOwner) {
      await sendMessage(chatId,
        `📊 <b>Bot Status</b>\n\n` +
        `👥 Subscribers: ${state.subscribers.length}\n` +
        `📨 Sent alerts: ${sentSet.size}\n` +
        `📞 Active calls: ${Object.keys(state.calls).length}\n` +
        `🔗 Webhook: ${process.env.PUBLIC_URL}${CFG.webhookPath}`
      );
    } else {
      await sendMessage(chatId, `👥 Subscribers: ${state.subscribers.length}`);
    }
  }
  
  if (text === '/watchlist') {
    const watchlist = state.watchlist[chatId] || [];
    if (watchlist.length === 0) {
      await sendMessage(chatId, '📭 Watchlist kosong. Gunakan /watch <CA> untuk menambahkan token.');
    } else {
      const list = watchlist.map((ca, i) => `${i+1}. <code>${ca}</code>`).join('\n');
      await sendMessage(chatId, `📋 <b>Watchlist Anda:</b>\n\n${list}`);
    }
  }
  
  if (text.startsWith('/watch ')) {
    const ca = text.split(' ')[1];
    if (ca && ca.length > 30) {
      if (!state.watchlist[chatId]) state.watchlist[chatId] = [];
      if (!state.watchlist[chatId].includes(ca)) {
        state.watchlist[chatId].push(ca);
        saveState(state);
        await sendMessage(chatId, `✅ Token <code>${ca}</code> ditambahkan ke watchlist.`);
      } else {
        await sendMessage(chatId, `⚠️ Token sudah ada di watchlist.`);
      }
    } else {
      await sendMessage(chatId, `❌ Format: /watch <contract_address>`);
    }
  }
  
  if (text.startsWith('/unwatch ')) {
    const ca = text.split(' ')[1];
    if (ca && state.watchlist[chatId]) {
      state.watchlist[chatId] = state.watchlist[chatId].filter(c => c !== ca);
      saveState(state);
      await sendMessage(chatId, `✅ Token <code>${ca}</code> dihapus dari watchlist.`);
    } else {
      await sendMessage(chatId, `❌ Format: /unwatch <contract_address>`);
    }
  }
});

// Set Telegram webhook
async function setTelegramWebhook() {
  const webhookUrl = `${process.env.PUBLIC_URL}/telegram-webhook`;
  try {
    await tg('deleteWebhook', {});
    await tg('setWebhook', { 
      url: webhookUrl,
      allowed_updates: ['message']
    });
    console.log('[telegram] webhook set to:', webhookUrl);
  } catch (e) {
    console.error('[telegram] setWebhook failed:', e.message);
  }
}

// Start server
app.listen(CFG.webhookPort, async () => {
  console.log('\n========================================');
  console.log('🚀 PUMP ALERT BOT - WEBHOOK MODE');
  console.log('========================================');
  console.log(`📡 Server running on port: ${CFG.webhookPort}`);
  console.log(`🔗 Helius webhook path: ${CFG.webhookPath}`);
  console.log(`🔑 Webhook secret: ${CFG.heliusWebhookSecret}`);
  console.log('========================================\n');
  
  await registerHeliusWebhook();
  await setTelegramWebhook();
  
  setInterval(checkMilestonesAndBroadcast, 30000);
  
  console.log('✅ Bot is ready! Semua fitur berjalan:\n');
  console.log('   ✓ Helius DAS API (real-time metadata)');
  console.log('   ✓ Top 10 Holders');
  console.log('   ✓ Social Links');
  console.log('   ✓ Token Image');
  console.log('   ✓ Milestone Tracking');
  console.log('   ✓ Filter (Age, Liquidity, MCap, Volume)');
  console.log('   ✓ Watchlist');
  console.log('   ✓ Real-time via Helius Webhook\n');
});
