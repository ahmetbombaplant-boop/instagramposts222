const app = require('./server');   // теперь только импорт
require('./worker');
const { bot, secretPath, webhook } = require('./bot');

app.use(require('express').json({ limit: '2mb' }));

if (webhook) {
  app.use(secretPath, webhook);
  console.log(`[bot] webhook bound on ${secretPath}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[all-in-one] server + worker + bot started`);
  console.log(`Server listening on port ${PORT}`);

  if (bot) {
    await bot.telegram.setWebhook(`${process.env.BASE_URL}${secretPath}`);
    console.log(`[bot] webhook set to ${process.env.BASE_URL}${secretPath}`);
  }
});
