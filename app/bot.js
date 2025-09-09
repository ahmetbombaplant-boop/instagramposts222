const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN');
  module.exports = { bot: null, secretPath: null };
  return;
}

const BASE = process.env.BASE_URL;
const secretPath = process.env.TG_SECRET_PATH ||
  `/tg-${Buffer.from(token).toString('base64url').slice(0, 24)}`;

const apiPost = (p, d) => axios.post(`${BASE}${p}`, d).then(r => r.data);
const apiGet  = (p)    => axios.get(`${BASE}${p}`).then(r => r.data);

const bot = new Telegraf(token);
const S = new Map();

function parsePicks(text) {
  return [...new Set((text.match(/\d+/g) || []).map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= 15))];
}

async function sendPreviews(ctx, previews) {
  try {
    // две группы: 10 + 5
    const group1 = previews.slice(0, 10).map((url, i) => ({ type: 'photo', media: url, caption: `#${i + 1}` }));
    if (group1.length) await ctx.replyWithMediaGroup(group1);
    const group2 = previews.slice(10, 15).map((url, i) => ({ type: 'photo', media: url, caption: `#${i + 11}` }));
    if (group2.length) await ctx.replyWithMediaGroup(group2);
    await ctx.reply('Выбери 7: отправь номера через пробел или запятые. Пример: 1 3 5 7 9 11 13. Команда /final — завершить.');
  } catch {
    // запасной вариант — по одному
    for (let i = 0; i < previews.length; i++) {
      await ctx.replyWithPhoto(previews[i], { caption: `#${i + 1}` });
    }
    await ctx.reply('Выбери 7: отправь номера. /final — завершить.');
  }
}

bot.start(async ctx => {
  const id = ctx.chat.id;
  S.set(id, { step: 'character', picks: [] });
  await ctx.reply('Кого берём? (персонаж/актёр)');
});

bot.hears(/\/help/i, async ctx => {
  await ctx.reply('Последовательность: /start → персонаж → тема → стиль → ждём превью → отправляешь 7 номеров → /final.');
});

bot.command('cancel', async ctx => {
  S.delete(ctx.chat.id);
  await ctx.reply('Ок, отменено. /start чтобы начать заново.');
});

bot.on('text', async ctx => {
  const id = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  let s = S.get(id);
  if (!s) return;

  if (s.step === 'character') {
    s.character = text; s.step = 'topic';
    return ctx.reply('Тема?');
  }
  if (s.step === 'topic') {
    s.topic = text; s.step = 'style';
    return ctx.reply('Стиль? (например: minimal, vintage, cinematic)');
  }
  if (s.step === 'style') {
    s.style = text || 'default'; s.step = 'waiting_previews';
    await ctx.reply(`Собираю 15 превью для: ${s.character} / ${s.topic} / ${s.style}…`);
    try {
      const { job_id } = await apiPost('/create-pack', {
        character: s.character, topic: s.topic, style: s.style, slides: 7, chat_id: id
      });
      s.job_id = job_id;

      // опрос статуса до preview_ready
      const t = setInterval(async () => {
        try {
          const st = await apiGet(`/status?job_id=${job_id}`);
          if (st?.state === 'preview_ready') {
            clearInterval(t);
            const out = await apiGet(`/previews?job_id=${job_id}`);
            s.step = 'picking';
            s.picks = [];
            await ctx.reply('Готово: 15 превью.');
            await sendPreviews(ctx, out.previews || []);
          }
          if (st?.state === 'error') {
            clearInterval(t);
            s.step = 'character';
            await ctx.reply('Ошибка при сборе превью. Попробуй ещё раз /start.');
          }
        } catch {}
      }, 1500);
    } catch (e) {
      s.step = 'character';
      return ctx.reply('Ошибка. Попробуй ещё раз /start.');
    }
  } else if (s.step === 'picking') {
    const picks = parsePicks(text);
    if (!picks.length) return; // игнорируем посторонний текст
    s.picks = [...new Set([...(s.picks || []), ...picks])].slice(0, 7);
    await ctx.reply(`Выбрано: ${s.picks.join(', ')} (${s.picks.length}/7). Команда /final — завершить.`);
  }
});

bot.command('final', async ctx => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');

  if (!s.picks || s.picks.length === 0) {
    return ctx.reply('Добавь хотя бы 1 номер (лучше 7), затем снова /final.');
  }

  try {
    const out = await apiPost('/finalize', { job_id: s.job_id, picks: s.picks, want_caption: true });
    if (!out.ok) throw new Error('finalize rejected');

    await ctx.reply('Финализация… подожди немного.');

    const t = setInterval(async () => {
      try {
        const st = await apiGet(`/status?job_id=${s.job_id}`);
        if (st?.state === 'done') {
          clearInterval(t);
          const fin = await apiGet(`/result?job_id=${s.job_id}`);
          for (const url of (fin.slides || [])) {
            await ctx.replyWithPhoto(url);
          }
          if (fin.caption) await ctx.reply(`Подпись:\n${fin.caption}`);
          S.delete(id);
        }
        if (st?.state === 'error') {
          clearInterval(t);
          await ctx.reply('Ошибка при финализации.');
        }
      } catch {}
    }, 1500);
  } catch (e) {
    await ctx.reply('Ошибка при финализации.');
  }
});

module.exports = { bot, secretPath };
