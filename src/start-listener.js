import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const START_ALERT_TEXT = process.env.START_ALERT_TEXT || 'Alert aktif.';

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

let offset = 0;

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function poll() {
  try {
    const updates = await tg('getUpdates', { timeout: 20, offset });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (!msg?.text) continue;

      const text = msg.text.trim();
      if (text === '/start' || text.startsWith('/start ')) {
        await tg('sendMessage', {
          chat_id: msg.chat.id,
          text: START_ALERT_TEXT,
          disable_web_page_preview: true,
        });
        console.log(`start alert sent -> chat ${msg.chat.id}`);
      }
    }
  } catch (e) {
    console.error('poll error:', e.message || String(e));
  }
}

console.log('start-listener running...');
await poll();
setInterval(poll, POLL_MS);
