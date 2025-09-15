const server = require('./server');
const { bot, secretPath } = require('./bot');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');

if (bot) {
  // маршрут вебхука для Telegram
  server.get(secretPath, (req, res) => res.status(200).send('tg webhook ok'));
  server.post(secretPath, (req, res) => bot.webhookCallback(secretPath)(req, res));
} else {
  console.warn('[bot] bot instance is null — webhook route not attached');
}

async function attemptSetWebhook(retry = 0) {
  if (!bot) return;
  if (!BASE) { console.warn('[bot] BASE_URL is empty'); return; }
  const url = `${BASE}${secretPath}`;
  try {
    await bot.telegram.setWebhook(url, { drop_pending_updates: false });
    console.log('[bot] webhook set to', url);
  } catch (e) {
    console.warn(`[bot] setWebhook failed (try ${retry + 1}):`, e?.message || String(e));
    if (retry < 5) setTimeout(() => attemptSetWebhook(retry + 1), 8000);
  }
}

// админка для дебага вебхука
server.get('/admin/webhook-info', async (req, res) => {
  try {
    if (!bot) return res.status(400).json({ ok:false, error:'bot disabled' });
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok:true, info });
  } catch (e) { res.status(500).json({ ok:false, error: e?.message || String(e) }); }
});
server.post('/admin/set-webhook', async (req, res) => {
  try {
    if (!bot) return res.status(400).json({ ok:false, error:'bot disabled' });
    if (!BASE) return res.status(400).json({ ok:false, error:'BASE_URL empty' });
    const url = `${BASE}${secretPath}`;
    await bot.telegram.setWebhook(url, { drop_pending_updates: false });
    console.log('[bot] webhook (manual) set to', url);
    res.json({ ok:true, url });
  } catch (e) { res.status(500).json({ ok:false, error: e?.message || String(e) }); }
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  attemptSetWebhook();
});
