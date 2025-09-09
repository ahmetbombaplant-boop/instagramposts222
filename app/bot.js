const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN');
  module.exports = { bot: null, secretPath: null };
  return;
}

const BASE = process.env.BASE_URL?.replace(/\/+$/, '') || '';
const secretPath = process.env.TG_SECRET_PATH || '/tg-hook';

const apiPost = (p, d) => axios.post(`${BASE}${p}`, d).then(r => r.data);
const apiGet  = (p)    => axios.get(`${BASE}${p}`).then(r => r.data);

const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '25', 10); // можно менять из env
const PICKS_TARGET  = parseInt(process.env.PICKS_TARGET  || '7', 10);  // сколько выбирать

const bot = new Telegraf(token);
const S = new Map();

// лог входящих апдейтов (удобно для дебага)
bot.use((ctx, next) => {
  try { console.log('[bot] update:', ctx.updateType, ctx.message?.text); } catch {}
  return next();
});

function parsePicks(text) {
  const max = PREVIEW_LIMIT;
  return [...new Set((text.match(/\d+/g) || [])
    .map(x => parseInt(x, 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= max))];
}

async function sendPreviews(ctx, previews) {
  if (!previews?.length) {
    await ctx.reply('Не смог получить превью. Попробуй ещё раз /start.');
    return;
  }
  try {
    // шлём 10 + 10 + остаток
    const mk = (arr, offset) => arr.map((url, i) => ({ type: 'photo', media: url, caption: `#${offset + i + 1}` }));
    const g1 = mk(previews.slice(0, 10), 0);
    if (g1.length) await ctx.replyWithMediaGroup(g1);
    const g2 = mk(previews.slice(10, 20), 10);
    if (g2.length) await ctx.replyWithMediaGroup(g2);
    const g3 = mk(previews.slice(20, PREVIEW_LIMIT), 20);
    if (g3.length) await ctx.replyWithMediaGroup(g3);

    await ctx.reply(
      `Выбери ${PICKS_TARGET}: напиши номера через пробел или запятые. Пример: 1 4 7 12 15 18 23. Команда /final — завершить.`
    );
  } catch (e) {
    console.error('[bot] media group failed, fallback:', e?.message);
    // fallback — по одному
    for (let i = 0; i < previews.length; i++) {
      try { await ctx.replyWithPhoto(previews[i], { caption: `#${i + 1}` }); } catch {}
    }
    await ctx.reply(`Выбери ${PICKS_TARGET} и напиши их номера. /final — завершить.`);
  }
}

bot.start(async ctx => {
  const id = ctx.chat.id;
  S.set(id, { step: 'character', picks: [] });
  await ctx.reply('Кого берём? (персонаж/актёр)');
});

bot.command('help', async ctx => {
  await ctx.reply(`/start → персонаж → тема → стиль → ждём превью → присылай ${PICKS_TARGET} номеров → /final`);
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
    await ctx.reply(`Собираю ${PREVIEW_LIMIT} превью для: ${s.character} / ${s.topic} / ${s.style}…`);
    try {
      const { job_id } = await apiPost('/create-pack', {
        character: s.character, topic: s.topic, style: s.style, slides: PICKS_TARGET, chat_id: id
      });
      s.job_id = job_id;

      // опрос статуса до preview_ready
      const t = setInterval(async () => {
        try {
          const st = await apiGet(`/status?job_id=${job_id}`);
          if (st?.state === 'preview_ready') {
            clearInterval(t);
            s.step = 'picking';
            s.picks = [];
            await ctx.reply(`Готово: ${PREVIEW_LIMIT} превью.`);

            // 10 попыток вытащить массив превью с паузой 700 мс
            let previews = [];
            for (let i = 0; i < 10; i++) {
              try {
                const out = await apiGet(`/previews?job_id=${job_id}`);
                previews = out?.previews || [];
                if (previews.length) break;
              } catch {}
              await new Promise(r => setTimeout(r, 700));
            }
            if (!previews.length) {
              console.warn('[bot] previews empty after retries', s.job_id);
              await ctx.reply('Не успел получить превью. Дай ещё секунду и набери /start заново.');
              s.step = 'character';
              return;
            }
            await sendPreviews(ctx, previews);
          }
          if (st?.state === 'error') {
            clearInterval(t);
            s.step = 'character';
            await ctx.reply('Ошибка при сборе превью. Попробуй ещё раз /start.');
          }
        } catch {}
      }, 1300);
    } catch (e) {
      console.error('[bot] create-pack failed', e?.message);
      s.step = 'character';
      return ctx.reply('Ошибка. Попробуй ещё раз /start.');
    }
    return;
  }

  if (s.step === 'picking') {
    const picks = parsePicks(text);
    if (!picks.length) return; // игнорируем посторонний текст
    s.picks = [...new Set([...(s.picks || []), ...picks])].slice(0, PICKS_TARGET);
    await ctx.reply(`Выбрано: ${s.picks.join(', ')} (${s.picks.length}/${PICKS_TARGET}). Команда /final — завершить.`);
  }
});

bot.command('final', async ctx => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');

  if (!s.picks || s.picks.length === 0) {
    return ctx.reply(`Добавь хотя бы 1 номер (лучше ${PICKS_TARGET}), затем снова /final.`);
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
            try { await ctx.replyWithPhoto(url); } catch {}
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
    console.error('[bot] finalize failed', e?.message);
    await ctx.reply('Ошибка при финализации.');
  }
});

module.exports = { bot, secretPath };
