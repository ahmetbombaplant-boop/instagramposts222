// app/worker.js
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const axios = require('axios');

const queueName = 'sigma-jobs';

// ---------- ENV ----------
const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '15', 10);
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const SERPAPI_KEY   = process.env.SERPAPI_KEY;

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('connect', () => console.log('[worker] Redis connected'));
redis.on('error', e => console.error('[worker] Redis error', e?.message));

const jobKey      = id => `job:${id}`;
const previewsKey = id => `job:${id}:previews`;

const now = () => new Date().toISOString();

async function loadJob(id) {
  if (!id) return null;
  const raw = await redis.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveJob(id, payload) {
  await redis.set(jobKey(id), JSON.stringify(payload), 'EX', 60 * 60 * 24);
}

async function tgSend(chatId, method, payload) {
  if (!TG_TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}`;
  try {
    await axios.post(url, payload, { timeout: 30000 });
  } catch (e) {
    console.error('[tg] send error:', e?.response?.data || e?.message);
  }
}

async function sendPreviewsToTelegram(chatId, previews, picksTarget = 7) {
  if (!TG_TOKEN || !chatId || !previews?.length) return;

  await tgSend(chatId, 'sendMessage', {
    chat_id: chatId,
    text: `Готово: ${previews.length} превью.\nВыбери ${picksTarget}: напиши номера через пробел или запятые. Пример: 1 3 5 7 9 11 13.\nКоманда /final — завершить.`
  });

  // Telegram ограничивает mediaGroup до 10 (лучше 9)
  let idx = 0;
  while (idx < previews.length) {
    const slice = previews.slice(idx, idx + 9);
    const media = slice.map((url, i) => ({
      type: 'photo',
      media: url,
      caption: `#${idx + i + 1}`
    }));

    try {
      await tgSend(chatId, 'sendMediaGroup', { chat_id: chatId, media });
    } catch (e) {
      // fallback: урезать группу
      for (let drop = 1; drop <= media.length; drop++) {
        const reduced = media.slice(0, media.length - drop);
        if (!reduced.length) break;
        try { await tgSend(chatId, 'sendMediaGroup', { chat_id: chatId, media: reduced }); break; } catch {}
      }
    }

    idx += slice.length;
  }
}

async function fetchPreviewsSerp({ character, topic, style }) {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  const q = [character, topic, style && style !== 'default' ? style : '']
    .filter(Boolean).join(' ').trim();

  const params = {
    engine: 'google',
    q,
    tbm: 'isch',
    ijn: 0,
    num: 100,
    api_key: SERPAPI_KEY,
    safe: (process.env.SERPAPI_SAFE || 'off').toLowerCase(),
  };

  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 20000 });
  const items = (data?.images_results || [])
    .map(x => x?.original || x?.thumbnail || x?.source)
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const url of items) {
    const u = String(url);
    if (!/^https?:\/\//i.test(u)) continue;
    if (u.endsWith('.svg')) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= PREVIEW_LIMIT) break;
  }
  return out;
}

new Worker(
  queueName,
  async (job) => {
    if (job.name !== 'build-previews') return;

    const { job_id, character, topic, style, chat_id } = job.data || {};
    console.log(`[worker] build-previews start ${job_id} "${character}" / "${topic}" / "${style}"`);

    const state = await loadJob(job_id);
    if (!state) {
      console.warn(`[worker] job not found ${job_id}`);
      return;
    }

    try {
      const previews = await fetchPreviewsSerp({ character, topic, style });

      if (!previews.length) {
        state.state = 'error';
        await saveJob(job_id, state);
        console.warn(`[worker] no images for ${job_id}`);
        return;
      }

      await redis.set(previewsKey(job_id), JSON.stringify(previews), 'EX', 60 * 60 * 24);
      state.state = 'preview_ready';
      await saveJob(job_id, state);

      console.log(`[worker] previews ready ${job_id} ${previews.length}`);

      // СЕРВЕРНЫЙ ПУШ В TG: без ожидания бота
      try {
        await sendPreviewsToTelegram(chat_id, previews, state.slides || 7);
      } catch (e) {
        console.error('[worker] previews push failed:', e?.message);
      }
    } catch (e) {
      state.state = 'error';
      await saveJob(job_id, state);
      console.error('[worker] build-previews failed', job_id, e?.message);
    }
  },
  { connection: redis }
);

console.log('[worker] listening queue "sigma-jobs"');
