// app/all-in-one.js
require('./server');
require('./worker');
const express = require('express');
const { bot, secretPath, webhook } = require('./bot');

const app = express();
app.use(express.json({ limit: '2mb' }));
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
