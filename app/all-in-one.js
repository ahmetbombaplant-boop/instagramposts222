const app = require('./server');
require('./worker');
const { bot, secretPath } = require('./bot');
const express = require('express');

// УБЕРИ другие use() для вебхука, чтобы не было дублей!

// 1) Явный парсер тела ТОЛЬКО на этом пути
app.use(secretPath, express.json({ limit: '2mb', type: '*/*' }));

// 2) GET для быстрой проверки в браузере (должен отдавать 200, НЕ 404)
app.get(secretPath, (req, res) => {
  res.status(200).send('OK TG WEBHOOK');
});

// 3) Лог входящих апдейтов — поможет увидеть, что реально приходит
app.post(secretPath, (req, res, next) => {
  try {
    console.log('[tg] inbound update:', JSON.stringify(req.body));
  } catch (_) {}
  next();
});

// 4) Сам обработчик Telegraf
app.post(secretPath, (req, res) => {
  return bot.webhookCallback(secretPath)(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[all-in-one] server + worker + bot started`);
  console.log(`Server listening on port ${PORT}`);

  if (bot) {
    // ВСЕГДА перевыставляем вебхук на тот же путь
    await bot.telegram.setWebhook(`${process.env.BASE_URL}${secretPath}`);
    console.log(`[bot] webhook set to ${process.env.BASE_URL}${secretPath}`);
  }
});
