const { bot, secretPath } = require('./bot');
const server = require('./server');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');

if (bot) {
  server.get(secretPath, (req, res) => res.status(200).send('tg webhook ok'));
  server.post(secretPath, (req, res) => bot.webhookCallback(secretPath)(req, res));
}

async function attemptSetWebhook(retry = 0) {
  if (!bot || !BASE) return;
  const url = `${BASE}${secretPath}`;
  try { await bot.telegram.setWebhook(url, { drop_pending_updates: false }); console.log('[bot] webhook set to', url); }
  catch (e) { console.warn(`[bot] setWebhook failed (try ${retry+1}):`, e?.message || e); if (retry < 5) setTimeout(() => attemptSetWebhook(retry+1), 8000); }
}

server.listen(PORT, async () => {
  console.log(`Server listening on 3000`);
  attemptSetWebhook();
});
