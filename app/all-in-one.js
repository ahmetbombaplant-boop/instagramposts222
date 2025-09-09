const server = require('./server');
const { bot, secretPath } = require('./bot');
require('./worker');

const PORT = process.env.PORT || 3000;

if (bot) {
  // принимаем апдейты телеги на вебхуке
  server.use(bot.webhookCallback(secretPath));
}

server.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  if (bot) {
    const url = process.env.BASE_URL;
    if (!url) {
      console.warn('[bot] BASE_URL is empty, webhook not set');
      return;
    }
    await bot.telegram.setWebhook(`${url}${secretPath}`);
    console.log('[bot] webhook set to', `${url}${secretPath}`);
  }
});
