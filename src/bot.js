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

  // Milestone (tetap ada)
  startMultiple: Number(process.env.START_MULTIPLE || 1.5),
  stepMultiple: Number(process.env.STEP_MULTIPLE || 0.5),

  // Bot behavior
  startAlertText: process.env.START_ALERT_TEXT ||
    '🚨 Alert aktif! Kamu sudah subscribe alert token. Ketik /stop untuk berhenti.\n\n' +
    '📋 <b>Perintah:</b>\n' +
    '/start - Mulai alert\n' +
    '/stop - Berhenti alert\n' +
    '/status - Lihat status bot\n' +
    '/watchlist - Lihat token yang dipantau\n' +
    '/setprice <CA> <target> - Set target harga',
  
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
    s.priceTargets = s.priceTargets && typeof s.priceTargets === 'object' ? s.priceTargets : {};
    return s;
  } catch {
    return { subscribers: [], sent: [], calls: {}, watchlist: {}, priceTargets: {} };
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

// Register webhook ke Helius
async function registerHeliusWebhook() {
  const webhookUrl = `${process.env.PUBLIC_URL}${CFG.webhookPath}`;
  
  // Hapus webhook lama
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
        displayOptions: {},
      }),
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
      pct: totalSupply > 0 ? ((a.amount / totalSupply) * 100).toFixed(2) : '0.00',
    }));
  } catch (e) {
    console.error('[fetchTopHolders] error:', e.message);
    return null;
  }
}

// Extract social links + image URL dari DexScreener
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

// Filter token
function filterToken(pairs, mintAddress) {
  const solanaPairs = pairs.filter(p => (p.chainId || '').toLowerCase() === CFG.chainId);
  if (!solanaPairs.length) return null;

  const bestPair = solanaPairs.sort((a, b) => toNum(b.volume?.h24) - toNum(a.volume?.h24))[0];
  
  const mc = toNum(bestPair.marketCap);
  const liq = toNum(bestPair.liquidity?.usd);
  const vol = toNum(bestPair.volume?.h24);
  const buys = toNum(bestPair.txns?.h1?.buys);
  const sells = toNum(bestPair.txns?.h1?.sells);
  const ratio = sells > 0 ? buys / sells : buys;
  const age = ageMinutes(bestPair.pairCreatedAt);

  if (age > CFG.maxAgeMin) return null;
  if (liq < CFG.minLiquidity) return null;
  if (mc < CFG.minMcap || mc > CFG.maxMcap) return null;
  if (vol < CFG.minVol24h) return null;

  return {
    pair: bestPair,
    mc, liq, vol, buys, sells, ratio, age
  };
}

// Build message (SAMA PERSIS DENGAN YANG DULU)
function buildMessage(item, holders, socials) {
  const { pair, mc, liq, vol, buys, sells, ratio, age } = item;
  const name = pair.baseToken?.name || 'Unknown';
  const symbol = pair.baseToken?.symbol || '?';
  const ca = pair.baseToken?.address || '-';
  const pairUrl = pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`;

  const score = Math.min(99, Math.max(1, Math.round((ratio * 30) + (liq / 2000) + (vol / 20000))));

  const holdersBlock = formatHoldersBlock(holders);
  const socialsBlock = formatSocialsBlock(socials);

  const lines = [
    `━━━━━━━━━━━━━━━━━━`,
    `🚨 <b>JANE CALL</b> 🟢`,
    `<b>${name} (${symbol})</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💵 <b>Price:</b> ${pair.priceUsd ? `$${pair.priceUsd}` : '-'}`,
    `📈 <b>24H:</b> ${toNum(pair.priceChange?.h24).toFixed(2)}%`,
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

  if (holdersBlock) {
    lines.push(``);
    lines.push(holdersBlock);
  }

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

// Track call untuk milestone
function ensureCallTracked(item, mintAddress) {
  const id = item.pair?.pairAddress || mintAddress;
  if (!id) return null;
  
  if (!state.calls[id]) {
    state.calls[id] = {
      id,
      tokenAddress: mintAddress,
      symbol: item.pair?.baseToken?.symbol || '?',
      name: item.pair?.baseToken?.name || 'Unknown',
      entryMcap: item.mc,
      entryPrice: toNum(item.pair?.priceUsd),
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

// Check milestones (tetap jalan)
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
          const replyToId = call.messageIds?.[String(chatId)];
          if (replyToId) {
            await sendReply(chatId, msg, replyToId);
          } else {
            await sendMessage(chatId, msg);
          }
        } catch (e) {
          console.error(`[milestone] chat ${chatId} failed:`, e.message);
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
            const replyToId = call.messageIds?.[String(chatId)];
            if (replyToId) {
              await sendReply(chatId, msg, replyToId);
            } else {
              await sendMessage(chatId, msg);
            }
          } catch (e) {
            console.error(`[milestone] chat ${chatId} failed:`, e.message);
          }
        }
      }
    }
  }
}

// ============ WEBHOOK HANDLER ============
app.post(CFG.webhookPath, async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  if (!signature || signature !== CFG.heliusWebhookSecret) {
    console.log('[webhook] invalid signature');
    return res.status(401).send('Invalid signature');
  }

  const transactions = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(200).send('OK');
  }

  console.log(`[webhook] received ${transactions.length} transactions`);
  
  // Extract mint addresses
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

  console.log(`[webhook] found ${mints.size} new mints`);

  // Proses setiap mint
  for (const mintAddress of mints) {
    try {
      // Fetch dari DexScreener
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      
      const filtered = filterToken(pairs, mintAddress);
      if (!filtered) {
        console.log(`[skip] ${mintAddress} tidak memenuhi kriteria`);
        continue;
      }

      // Fetch holders dan socials (SAMA PERSIS DENGAN YANG DULU)
      const [holders, socialsRaw] = await Promise.all([
        fetchTopHolders(mintAddress),
        Promise.resolve(extractSocials(filtered.pair))
      ]);

      const msg = buildMessage(filtered, holders, socialsRaw);
      const imageUrl = socialsRaw?.imageUrl || null;
      
      const callId = ensureCallTracked(filtered, mintAddress);
      
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
      
      console.log(`[sent] ${filtered.pair.baseToken?.symbol} (${mintAddress})`);
      
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
      await sendMessage(
        chatId,
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
  
  // FITUR BARU: Lihat watchlist
  if (text === '/watchlist') {
    const watchlist = state.watchlist[chatId] || [];
    if (watchlist.length === 0) {
      await sendMessage(chatId, '📭 Watchlist kosong. Gunakan /watch <CA> untuk menambahkan token.');
    } else {
      const list = watchlist.map((ca, i) => `${i+1}. <code>${ca}</code>`).join('\n');
      await sendMessage(chatId, `📋 <b>Watchlist Anda:</b>\n\n${list}`);
    }
  }
  
  // FITUR BARU: Tambah ke watchlist
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
  
  // FITUR BARU: Hapus dari watchlist
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
  
  // Milestone checker tetap jalan (interval 30 detik)
  setInterval(checkMilestonesAndBroadcast, 30000);
  
  console.log('✅ Bot is ready! Semua fitur berjalan:\n');
  console.log('   ✓ Top 10 Holders');
  console.log('   ✓ Social Links (Twitter, Telegram, Discord, Website)');
  console.log('   ✓ Token Image');
  console.log('   ✓ Milestone Tracking (1.5x, 2x, 2.5x, ...)');
  console.log('   ✓ Filter (Age, Liquidity, MCap, Volume)');
  console.log('   ✓ Watchlist');
  console.log('   ✓ Real-time via Helius Webhook\n');
});
