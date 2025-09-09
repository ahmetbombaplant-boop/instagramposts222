const express = require('express');
const IORedis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios');
const { Queue } = require('bullmq');

const app = express();
app.use(express.json({ limit: '1mb' }));

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', e => console.error('[api] Redis error', e?.message));

const queueName = 'sigma-jobs';
const queue = new Queue(queueName, { connection: redis });

const jobKey       = id => `job:${id}`;
const previewsKey  = id => `job:${id}:previews`;   // JSON [urls]
const finalKey     = id => `job:${id}:final`;      // JSON { slides:[], caption:"" }

async function loadJob(id) {
  if (!id) return null;
  const raw = await redis.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveJob(id, payload) {
  await redis.set(jobKey(id), JSON.stringify(payload), 'EX', 60 * 60 * 24); // 24h
}

app.get('/', (req, res) => res.send('API работает!'));

// создать задачу на поиск превью
app.post('/create-pack', async (req, res) => {
  try {
    const { character, topic, style = 'default', slides = 7, chat_id } = req.body || {};
    if (!character || !topic) return res.status(400).json({ error: 'character/topic required' });

    const job_id = crypto.randomUUID();
    const payload = {
      job_id, character, topic, style, slides, chat_id,
      state: 'creating', picks: [], created_at: Date.now()
    };
    await saveJob(job_id, payload);

    await queue.add(
      'build-previews',
      { job_id, character, topic, style },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000
      }
    );

    res.json({ ok: true, job_id });
  } catch (e) {
    console.error('[api] /create-pack', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// статус
app.get('/status', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    const previewsRaw = await redis.get(previewsKey(job_id));
    const count = previewsRaw ? (JSON.parse(previewsRaw)?.length || 0) : 0;

    res.json({ ok: true, state: job.state, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// получить массив из 15 превью
app.get('/previews', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    const previewsRaw = await redis.get(previewsKey(job_id));
    const previews = previewsRaw ? JSON.parse(previewsRaw) : [];
    res.json({ ok: true, previews });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// запрос на финализацию: дергаем n8n и сразу возвращаем
app.post('/finalize', async (req, res) => {
  try {
    const { job_id, picks = [], want_caption = true } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    const previewsRaw = await redis.get(previewsKey(job_id));
    const previews = previewsRaw ? JSON.parse(previewsRaw) : [];
    if (!previews.length) return res.status(400).json({ ok: false, error: 'no previews yet' });

    // нормализуем индексы 1..N
    const uniq = [...new Set(
      picks.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= previews.length)
    )];

    const targetCount = job.slides || 7;
    const selected = uniq.slice(0, targetCount).map(n => previews[n - 1]);
    if (selected.length === 0) {
      return res.status(400).json({ ok: false, error: 'no valid picks' });
    }

    job.state = 'finalizing';
    job.picks = uniq;
    await saveJob(job_id, job);

    const callback = `${process.env.BASE_URL}/callback/n8n/final?token=${encodeURIComponent(process.env.N8N_CALLBACK_SECRET || 'change-me')}`;

    if (!process.env.N8N_FINALIZE_URL) {
      return res.status(500).json({ ok: false, error: 'N8N_FINALIZE_URL not set' });
    }

    // отправляем в n8n задание на сбор финала
    axios.post(process.env.N8N_FINALIZE_URL, {
      job_id,
      character: job.character,
      topic: job.topic,
      style: job.style,
      slides: targetCount,
      want_caption,
      picks: uniq,
      selected,        // прямые ссылки на выбранные изображения
      callback_url: callback
    }).catch(e => console.error('[api] n8n finalize error:', e?.message));

    res.status(202).json({ ok: true, state: 'finalizing' });
  } catch (e) {
    console.error('[api] /finalize', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// получить финальный результат (7 картинок + подпись)
app.get('/result', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    const raw = await redis.get(finalKey(job_id));
    if (!raw) return res.status(404).json({ ok: false, state: job.state || 'finalizing' });

    const final = JSON.parse(raw);
    res.json({ ok: true, slides: final.slides || [], caption: final.caption || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// колбэк из n8n: сохраняем финал и завершаем джоб
app.post('/callback/n8n/final', async (req, res) => {
  try {
    const token = (req.query.token || '').toString();
    const secret = process.env.N8N_CALLBACK_SECRET || 'change-me';
    if (!secret || token !== secret) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { job_id, slides = [], caption = '' } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    await redis.set(finalKey(job_id), JSON.stringify({ slides, caption }), 'EX', 60 * 60 * 24);
    job.state = 'done';
    await saveJob(job_id, job);

    res.json({ ok: true });
  } catch (e) {
    console.error('[api] /callback/n8n/final', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = app;
