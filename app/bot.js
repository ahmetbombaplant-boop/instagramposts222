const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN');
  module.exports = { bot: null, secretPath: null };
  return;
}

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const secretPath = process.env.TG_SECRET_PATH ||
  `/tg-${Buffer.from(token).toString('base64url').slice(0, 24)}`;

const apiPost = (p, d) => axios.post(`${BASE}${p}`, d).then(r => r.data);
const apiGet  = (p)    => axios.get(`${BASE}${p}`).then(r => r.data);

const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '15', 10);
const PICKS_TARGET  = parseInt(process.env.PICKS_TARGET  || '7', 10);

const bot = new Telegraf(token);
const S = new Map();

function parsePicks(text) {
  return [...new Set((text.match(/\d+/g) || [])
    .map(x => parseInt(x, 10))
    .filter(n => n >= 1 && n <= PREVIEW_LIMIT))];
}
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
async function sendPreviews(ctx, previews) {
  if (!previews?.length) {
    await ctx.reply('Превью не найдены. Попробуй /start ещё раз.');
    return;
  }
  const groups = chunk(previews.slice(0, PREVIEW_LIMIT), 9);
  let offset = 0;
  for (const g of groups) {
    const media = g.map((url, i) => ({ type: 'photo', media: url, caption: `#${offset + i + 1}` }));
    try {
      await ctx.replyWithMediaGroup(media);
    } catch {
      for (let drop = 1; drop < media.length; drop++) {
        const reduced = media.slice(0, media.length - drop);
        if (!reduced.length) break;
        try { await ctx.replyWithMediaGroup(reduced); break; } catch {}
      }
    }
    offset += g.length;
  }
  await ctx.reply(`Выбери ${PICKS_TARGET}: напиши номера через пробел или запятые. Пример: 1 4 7 9 11 13. Команда /final — завершить.`);
}

bot.use((ctx, next) => { try { console.log('[bot] update:', ctx.updateType, ctx.message?.text); } catch {} ; return next(); });

bot.command('final', async ctx => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');
  if (!s.picks?.length) return ctx.reply(`Добавь хотя бы 1 номер (лучше ${PICKS_TARGET}), затем снова /final.`);

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
          for (const url of (fin.slides || [])) try { await ctx.replyWithPhoto(url); } catch {}
          if (fin.caption) await ctx.reply(`Подпись:\n${fin.caption}`);
          S.delete(id);
        }
        if (st?.state === 'error') { clearInterval(t); await ctx.reply('Ошибка при финализации.'); }
      } catch {}
    }, 1500);
  } catch {
    await ctx.reply('Ошибка при финализации.');
  }
});

bot.start(async ctx => { S.set(ctx.chat.id, { step: 'character', picks: [] }); await ctx.reply('Кого берём? (персонаж/актёр)'); });
bot.hears(/\/help/i, async ctx => { await ctx.reply(`/start → персонаж → тема → стиль → превью (${PREVIEW_LIMIT}) → отправляешь ${PICKS_TARGET} номеров → /final.`); });
bot.command('cancel', async ctx => { S.delete(ctx.chat.id); await ctx.reply('Ок, отменено. /start чтобы начать заново.'); });

bot.on('text', async ctx => {
  const id = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  let s = S.get(id);
  if (!s) return;

  if (s.step === 'character') { s.character = text; s.step = 'topic'; return ctx.reply('Тема?'); }
  if (s.step === 'topic')     { s.topic = text;     s.step = 'style'; return ctx.reply('Стиль? (например: minimal, vintage, cinematic)'); }
  if (s.step === 'style') {
    s.style = text || 'default'; s.step = 'waiting_previews';
    await ctx.reply(`Собираю ${PREVIEW_LIMIT} превью для: ${s.character} / ${s.topic} / ${s.style}…`);
    try {
      const { job_id } = await apiPost('/create-pack', { character: s.character, topic: s.topic, style: s.style, slides: PICKS_TARGET, chat_id: id });
      s.job_id = job_id;
      const t = setInterval(async () => {
        try {
          const st = await apiGet(`/status?job_id=${job_id}`);
          if (st?.state === 'preview_ready') {
            clearInterval(t);
            const out = await apiGet(`/previews?job_id=${job_id}`);
            s.step = 'picking'; s.picks = [];
            await ctx.reply(`Готово: ${PREVIEW_LIMIT} превью.`);
            await sendPreviews(ctx, out.previews || []);
          }
          if (st?.state === 'error') { clearInterval(t); s.step = 'character'; await ctx.reply('Ошибка при сборе превью. Попробуй ещё раз /start.'); }
        } catch {}
      }, 1500);
    } catch {
      s.step = 'character'; return ctx.reply('Ошибка. Попробуй ещё раз /start.');
    }
    return;
  }

  if (s.step === 'picking') {
    const picks = parsePicks(text);
    if (!picks.length) return;
    const PICKS_TARGET = parseInt(process.env.PICKS_TARGET || '7', 10);
    s.picks = [...new Set([...(s.picks || []), ...picks])].slice(0, PICKS_TARGET);
    await ctx.reply(`Выбрано: ${s.picks.join(', ')} (${s.picks.length}/${PICKS_TARGET}). Команда /final — завершить.`);
  }
});

module.exports = { bot, secretPath };
