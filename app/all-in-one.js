// app/all-in-one.js
const { bot, secretPath } = require('./bot');
const server = require('./server');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');

async function attemptSetWebhook(retry = 0) {
  if (!bot) {
    console.warn('[bot] no bot instance, skip setWebhook');
    return;
  }
  if (!BASE) {
    console.warn('[bot] BASE_URL is empty, skip setWebhook');
    return;
  }
  const url = `${BASE}${secretPath}`;
  try {
    await bot.telegram.setWebhook(url, { drop_pending_updates: false });
    console.log('[bot] webhook set to', url);
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`[bot] setWebhook failed (try ${retry + 1}):`, msg);
    // не валим процесс — пробуем повторить
    if (retry < 5) setTimeout(() => attemptSetWebhook(retry + 1), 8000);
  }
}

// Админ-эндпоинты для дебага вебхука
server.get('/admin/webhook-info', async (req, res) => {
  try {
    if (!bot) return res.status(400).json({ ok: false, error: 'bot disabled' });
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

server.post('/admin/set-webhook', async (req, res) => {
  try {
    if (!bot) return res.status(400).json({ ok: false, error: 'bot disabled' });
    if (!BASE) return res.status(400).json({ ok: false, error: 'BASE_URL is empty' });
    const url = `${BASE}${secretPath}`;
    await bot.telegram.setWebhook(url, { drop_pending_updates: false });
    res.json({ ok: true, url });
    console.log('[bot] webhook (manual) set to', url);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

server.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  // пробуем поставить вебхук, но без краша при ошибке
  attemptSetWebhook();
});
