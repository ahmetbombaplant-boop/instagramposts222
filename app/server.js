// app/server.js
const express = require('express');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const cloudinary = require('cloudinary').v2;

const { createJobRecord, setPreview, getStatus, getPreview, getPicks } = require('./lib/store');
const { renderFinalSlides, genCaption } = require('./lib/render');

const app = express();
app.use(express.json());

// ===== Redis + BullMQ общие опции Upstash/TLS =====
const redisOpts = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: { rejectUnauthorized: false },
};
const redis = new IORedis(process.env.REDIS_URL, redisOpts);
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', (e) => console.error('[api] Redis error', e?.message));

const queueName = 'sigma-jobs';
const queue = new Queue(queueName, { connection: redis });

// Cloudinary (не сваливаться, если не настроен)
let cloudinaryReady = true;
try { cloudinary.config(true); } catch (e) { cloudinaryReady = false; console.log('[cloudinary] disabled:', e.message); }

// ---------- Health ----------
app.get('/', (req, res) => res.send('API работает!'));

app.get('/health/redis', async (req, res) => {
  try { res.json({ ok: true, pong: await redis.ping() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/health/queue', async (req, res) => {
  try {
    const job = await queue.add('test', { ts: Date.now() });
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health/cloudinary', async (req, res) => {
  if (!cloudinaryReady) return res.status(400).json({ ok: false, error: 'CLOUDINARY_URL invalid or missing' });
  try {
    const r = await cloudinary.uploader.upload('https://res.cloudinary.com/demo/image/upload/sample.jpg', { folder: 'sigma-test' });
    res.json({ ok: true, secure_url: r.secure_url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Pack API (без n8n) ----------

// создать задачу по персонажу/теме
app.post('/create-pack', async (req, res) => {
  const { character, topic = '', style = 'default', slides = 7, chat_id = '' } = req.body || {};
  if (!character) return res.status(400).json({ error: 'character required' });
  const job = await queue.add('pack:collect', { character, topic, style, slides, chat_id });
  await createJobRecord(job.id, { character, topic, style, slides, chat_id });
  res.json({ job_id: job.id });
});

// статус + превью
app.get('/status', async (req, res) => {
  if (!req.query.job_id) return res.status(400).json({ error: 'job_id required' });
  res.json(await getStatus(req.query.job_id));
});

// финализация (берёт выбранные позиции из Redis-пула /bot)
app.post('/finalize', async (req, res) => {
  const { job_id, picks = [], want_caption = true } = req.body || {};
  if (!job_id) return res.status(400).json({ error: 'job_id required' });

  const st = await getStatus(job_id);
  if (st.state !== 'preview_ready') return res.status(400).json({ error: 'preview not ready' });

  const chosen = picks.length ? picks : (await getPicks(job_id));
  if (chosen.length !== st.limit_pick) return res.status(400).json({ error: `need ${st.limit_pick} picks, have ${chosen.length}` });

  const preview = await getPreview(job_id);
  const selected = chosen.map(n => preview[n - 1]);

  const slides = await renderFinalSlides(selected);
  const caption = want_caption ? await genCaption(selected) : '';

  res.json({ state: 'done', slides, caption });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
