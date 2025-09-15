// app/server.js
const express = require('express');
const IORedis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios');
const { Queue } = require('bullmq');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Redis ----------
const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', e => console.error('[api] Redis error', e?.message));

// ---------- BullMQ ----------
const queueName = 'sigma-jobs';
const queue = new Queue(queueName, { connection: redis });

// ---------- Keys ----------
const jobKey      = id => `job:${id}`;
const previewsKey = id => `job:${id}:previews`;
const finalKey    = id => `job:${id}:final`;

// ---------- Helpers ----------
async function loadJob(id) {
  if (!id) return null;
  const raw = await redis.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveJob(id, payload) {
  await redis.set(jobKey(id), JSON.stringify(payload), 'EX', 60 * 60 * 24);
}
const now = () => new Date().toISOString();

// ---------- Health ----------
app.get('/', (req, res) => res.send('API работает!'));

// ---------- Create ----------
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

    console.log(`[final][${now()}] CREATE job=${job_id} char="${character}" topic="${topic}" style="${style}" slides=${slides}`);

    await queue.add(
      'build-previews',
      { job_id, character, topic, style },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 1000 }
    );

    res.json({ ok: true, job_id });
  } catch (e) {
    console.error('[api] /create-pack', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Status ----------
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

// ---------- Previews ----------
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

// ---------- Finalize ----------
app.post('/finalize', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[final][${now()}] API /finalize called from ip=${ip} body=`, JSON.stringify(req.body));

    const { job_id, picks = [], want_caption = true } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) {
      console.warn(`[final][${now()}] FINALIZE job not found job=${job_id}`);
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    const previewsRaw = await redis.get(previewsKey(job_id));
    const previews = previewsRaw ? JSON.parse(previewsRaw) : [];
    if (!previews.length) {
      console.warn(`[final][${now()}] FINALIZE no previews job=${job_id}`);
      return res.status(400).json({ ok: false, error: 'no previews yet' });
    }

    const uniq = [...new Set(
      (picks || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= previews.length)
    )];

    const targetCount = job.slides || 7;
    const selected = uniq.slice(0, targetCount).map(n => previews[n - 1]);
    if (!selected.length) {
      console.warn(`[final][${now()}] FINALIZE no valid selection job=${job_id}`);
      return res.status(400).json({ ok: false, error: 'no valid picks' });
    }

    job.state = 'finalizing';
    job.picks = uniq;
    job.finalize_requested_at = Date.now();
    await saveJob(job_id, job);

    if (!process.env.N8N_FINALIZE_URL) {
      console.error(`[final][${now()}] FINALIZE missing N8N_FINALIZE_URL`);
      return res.status(500).json({ ok: false, error: 'N8N_FINALIZE_URL not set' });
    }

    const payload = {
      job_id,
      character: job.character,
      topic: job.topic,
      style: job.style,
      slides: targetCount,
      want_caption,
      picks: uniq,
      selected,
      callback_url: `${process.env.BASE_URL}/callback/n8n/final`
    };

    console.log(`[final][${now()}] AUTHORIZED → N8N POST ${process.env.N8N_FINALIZE_URL}`);
    console.log(`[final][${now()}] payload:`, JSON.stringify({ ...payload, selected_count: selected.length, selected: undefined }, null, 2));

    axios.post(process.env.N8N_FINALIZE_URL, payload, { timeout: 30000 })
      .then(r => console.log(`[final][${now()}] N8N accepted status=${r.status}`))
      .catch(e => console.error(`[final][${now()}] N8N ERROR:`, e?.response?.data || e?.message));

    res.status(202).json({ ok: true, state: 'finalizing' });
  } catch (e) {
    console.error('[api] /finalize', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Result ----------
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

// ---------- Callback from n8n ----------
app.post('/callback/n8n/final', async (req, res) => {
  try {
    const { job_id, slides = [], caption = '' } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) {
      console.warn(`[final][${now()}] CALLBACK job not found job=${job_id}`);
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    console.log(`[final][${now()}] ← N8N CALLBACK job=${job_id} slides=${slides.length}`);
    await redis.set(finalKey(job_id), JSON.stringify({ slides, caption }), 'EX', 60 * 60 * 24);
    job.state = 'done';
    await saveJob(job_id, job);

    console.log(`[final][${now()}] SAVED final to Redis job=${job_id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[api] /callback/n8n/final', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = app;
