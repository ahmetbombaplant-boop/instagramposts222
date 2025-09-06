const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN provided — bot disabled');
  return;
}

const bot = new Telegraf(token);
bot.start(ctx => ctx.reply('Я жив. Напиши — повторю.'));
bot.on('text', ctx => ctx.reply(`Эхо: ${ctx.message.text}`));
bot.launch().then(() => console.log('[bot] launched (polling)'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
