// app/bot.js — Telegraf через webhook
const { Telegraf } = require('telegraf');
const { togglePick, getPicks } = require('./lib/store');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN provided — bot disabled');
  module.exports = null;
  return;
}

const BASE = process.env.BASE_URL || '';
if (!BASE) console.log('[bot] BASE_URL is empty — API calls may fail');

// Секретный путь вебхука
const secretPath =
  process.env.TG_SECRET_PATH ||
  `/tg-${Buffer.from(token).toString('base64url').slice(0, 24)}`;

const api = (p, d) => axios.post(`${BASE}${p}`, d).then(r => r.data);
const get = (p) => axios.get(`${BASE}${p}`).then(r => r.data);

const bot = new Telegraf(token);
const S = new Map();

// /start
bot.start(ctx => {
  const id = ctx.chat.id;
  S.set(id, { step: 'character' });
  ctx.reply('Кого берём? (персонаж/актёр)');
});

// /new
bot.command('new', ctx => {
  const id = ctx.chat.id;
  S.set(id, { step: 'character' });
  ctx.reply('Кого берём? (персонаж/актёр)');
});

// шаги диалога
bot.on('text', async (ctx) => {
  const id = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  let s = S.get(id);
  if (!s) return;

  if (s.step === 'character') {
    s.character = text;
    s.step = 'topic';
    return ctx.reply('Тема? (коротко: mood/сцена)');
  }

  if (s.step === 'topic') {
    s.topic = text;
    s.step = 'style';
    return ctx.reply('Стиль? (например: default)');
  }

  if (s.step === 'style') {
    s.style = text || 'default';
    s.step = 'wait';
    ctx.reply(`Собираю 15 превью для: ${s.character} / ${s.topic}…`);

    try {
      const { job_id } = await api('/create-pack', {
        character: s.character, topic: s.topic, style: s.style, slides: 7, chat_id: id
      });
      s.job_id = job_id;

      const t = setInterval(async () => {
        try {
          const st = await get(`/status?job_id=${job_id}`);
          if (st.state === 'preview_ready') {
            clearInterval(t);
            ctx.reply('Готово: 15 превью. Пиши числа 1..15, чтобы выбрать 7 штук. Команды: /rec — авто выбор, /final — завершить.');
          }
        } catch (_) {}
      }, 1500);
    } catch (e) {
      s.step = 'character';
      return ctx.reply('Ошибка при создании задачи. Попробуй ещё раз.');
    }
    return;
  }

  if (s.step === 'wait') {
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 1 || n > 15) return;
    const c = await togglePick(s.job_id, n);
    return ctx.reply(`Выбрано ${c}/7`);
  }
});

// авто-рекомендация: первые 7
bot.command('rec', async (ctx) => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');
  for (let i = 1; i <= 7; i++) await togglePick(s.job_id, i);
  ctx.reply('Рекомендовал 7. Жми /final');
});

// финализация
bot.command('final', async (ctx) => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');
  const picks = await getPicks(s.job_id);
  if (picks.length !== 7) return ctx.reply(`Нужно 7, выбрано ${picks.length}`);
  try {
    const out = await api('/finalize', { job_id: s.job_id, picks, want_caption: true });
    for (const url of out.slides) await ctx.replyWithPhoto(url);
    await ctx.reply(`Подпись:\n${out.caption}`);
    S.delete(id);
  } catch (e) {
    ctx.reply('Ошибка при финализации.');
  }
});

console.log(`[bot] initialized with webhook path ${secretPath}`);
module.exports = { bot, secretPath, webhook: bot.webhookCallback(secretPath) };
