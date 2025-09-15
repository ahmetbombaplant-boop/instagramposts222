const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log('[bot] no TELEGRAM_BOT_TOKEN');
  module.exports = { bot: null, secretPath: null };
  return;
}
const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const secretPath = process.env.TG_SECRET_PATH || `/tg-${Buffer.from(token).toString('base64url').slice(0,24)}`;

const apiPost = (p, d) => axios.post(`${BASE}${p}`, d).then(r => r.data);
const apiGet  = (p)    => axios.get(`${BASE}${p}`).then(r => r.data);

const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '15', 10);
const PICKS_TARGET  = parseInt(process.env.PICKS_TARGET  || '7', 10);

const bot = new Telegraf(token);
const S = new Map();

function parsePicks(text){
  return [...new Set((text.match(/\d+/g) || [])
    .map(x=>parseInt(x,10))
    .filter(n=>n>=1 && n<=PREVIEW_LIMIT))];
}
function chunk(arr,n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

async function sendPreviews(ctx, previews){
  if (!previews?.length){ await ctx.reply('Превью не найдены. /start'); return; }
  const groups = chunk(previews.slice(0, PREVIEW_LIMIT), 9);
  let offset = 0;
  for (const g of groups){
    const media = g.map((url,i)=>({ type:'photo', media:url, caption:`#${offset+i+1}` }));
    try { await ctx.replyWithMediaGroup(media); }
    catch(e){
      console.error('[bot] mediaGroup failed:', e?.message);
      for (let drop=0; drop<g.length; drop++){
        const reduced = media.slice(0, media.length - drop - 1);
        if (!reduced.length) break;
        try { await ctx.replyWithMediaGroup(reduced); break; } catch {}
      }
    }
    offset += g.length;
  }
  await ctx.reply(`Выбери ${PICKS_TARGET}: номера через пробел/запятые. Пример: 1 3 5 7 9 11 13. Команда /final — завершить.`);
}

// лог апдейтов
bot.use((ctx,next)=>{ try{ console.log('[bot] update:', ctx.updateType, ctx.message?.text); }catch{} return next(); });

// /final — раньше on('text')
bot.command('final', async ctx => {
  const id = ctx.chat.id;
  const s = S.get(id);
  if (!s?.job_id) return ctx.reply('Сначала /start');
  if (!s.picks?.length) return ctx.reply(`Добавь номера (лучше ${PICKS_TARGET}), потом /final.`);

  console.log('[bot] /final → POST /finalize', { job_id: s.job_id, picks: s.picks });

  try{
    const out = await apiPost('/finalize', { job_id: s.job_id, picks: s.picks, want_caption: true });
    console.log('[bot] /finalize response:', out);
    if (!out.ok) throw new Error('finalize rejected');

    await ctx.reply('Финализация… подожди немного.');

    const POLL_INTERVAL_MS = 1500;
    const POLL_TIMEOUT_MS  = 5 * 60 * 1000;
    const start = Date.now();
    const timer = setInterval(async () => {
      try{
        const st = await apiGet(`/status?job_id=${s.job_id}`);
        if (st?.state === 'done'){
          clearInterval(timer);
          const fin = await apiGet(`/result?job_id=${s.job_id}`);
          for (const url of (fin.slides||[])) { try{ await ctx.replyWithPhoto(url); }catch{} }
          if (fin.caption) await ctx.reply(`Подпись:\n${fin.caption}`);
          S.delete(id);
          return;
        }
        if (st?.state === 'error'){
          clearInterval(timer);
          await ctx.reply('Ошибка при финализации.');
          return;
        }
      }catch(e){
        const code = e?.response?.status || 0;
        if (code && code < 500) console.error('[bot] poll status error:', code);
      }
      if (Date.now() - start > POLL_TIMEOUT_MS){
        clearInterval(timer);
        await ctx.reply('Долго нет ответа. Попробуй /final чуть позже.');
      }
    }, POLL_INTERVAL_MS);

  }catch(e){
    console.error('[bot] finalize failed:', e?.message);
    await ctx.reply('Ошибка при финализации.');
  }
});

bot.start(async ctx => {
  const id = ctx.chat.id;
  S.set(id, { step:'character', picks:[] });
  await ctx.reply('Кого берём? (персонаж/актёр)');
});
bot.hears(/\/help/i, ctx => ctx.reply(`/start → персонаж → тема → стиль → превью (${PREVIEW_LIMIT}) → выбери ${PICKS_TARGET} → /final`));
bot.command('cancel', ctx => { S.delete(ctx.chat.id); ctx.reply('Ок, отменено. /start — заново.'); });

// текстовый сценарий
bot.on('text', async ctx => {
  const id = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return; // не перехватываем команды

  let s = S.get(id);
  if (!s) return;

  if (s.step === 'character'){ s.character = text; s.step='topic'; return ctx.reply('Тема?'); }
  if (s.step === 'topic'){ s.topic = text; s.step='style'; return ctx.reply('Стиль? (minimal, vintage, cinematic)'); }
  if (s.step === 'style'){
    s.style = text || 'default'; s.step='waiting_previews';
    await ctx.reply(`Собираю ${PREVIEW_LIMIT} превью для: ${s.character} / ${s.topic} / ${s.style}…`);
    try{
      const { job_id } = await apiPost('/create-pack', { character:s.character, topic:s.topic, style:s.style, slides:PICKS_TARGET, chat_id:id });
      s.job_id = job_id;
      const t = setInterval(async () => {
        try{
          const st = await apiGet(`/status?job_id=${job_id}`);
          if (st?.state === 'preview_ready'){
            clearInterval(t);
            const out = await apiGet(`/previews?job_id=${job_id}`);
            s.step = 'picking'; s.picks = [];
            await ctx.reply(`Готово: ${PREVIEW_LIMIT} превью.`);
            await sendPreviews(ctx, out.previews || []);
          }
          if (st?.state === 'error'){ clearInterval(t); s.step='character'; await ctx.reply('Ошибка при сборе. /start'); }
        }catch{}
      }, 1500);
    }catch(e){
      console.error('[bot] /create-pack failed:', e?.message);
      s.step='character'; return ctx.reply('Ошибка. /start');
    }
    return;
  }

  if (s.step === 'picking'){
    const picks = parsePicks(text);
    if (!picks.length) return;
    s.picks = [...new Set([...(s.picks||[]), ...picks])].slice(0, PICKS_TARGET);
    await ctx.reply(`Выбрано: ${s.picks.join(', ')} (${s.picks.length}/${PICKS_TARGET}). /final — завершить.`);
  }
});

module.exports = { bot, secretPath };
