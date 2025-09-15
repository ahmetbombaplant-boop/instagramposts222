const express = require('express');
const IORedis = require('ioredis');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Redis (устойчивые реконнекты) ----------
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(1000 * 2 ** times, 15000),
  reconnectOnError: () => true,
});
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', e => console.error('[api] Redis error', e?.message));

// ---------- keys ----------
const jobKey      = id => `job:${id}`;
const previewsKey = id => `job:${id}:previews`;
const finalKey    = id => `job:${id}:final`;

const PREVIEW_LIMIT = parseInt(process.env.PREVIEW_LIMIT || '15', 10);
const now = () => new Date().toISOString();

// ---------- helpers ----------
async function loadJob(id){ if(!id) return null; const raw = await redis.get(jobKey(id)); return raw?JSON.parse(raw):null; }
async function saveJob(id, payload){ await redis.set(jobKey(id), JSON.stringify(payload), 'EX', 86400); }

// Simple SerpAPI fetcher (Google Images)
async function fetchPreviewsSerp({ character, topic, style }) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY not set');
  const q = [character, topic, style && style!=='default' ? style : '']
    .filter(Boolean).join(' ').trim();

  const params = {
    engine: 'google',
    q,
    tbm: 'isch',
    ijn: 0,
    num: 100,
    api_key: key,
    safe: (process.env.SERPAPI_SAFE || 'off').toLowerCase(), // 'active'|'off'
  };

  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 20000 });
  const items = (data?.images_results || [])
    .map(x => x?.original || x?.thumbnail || x?.source)
    .filter(Boolean);

  // уникальные https, без data: и без svg
  const uniq = [];
  const seen = new Set();
  for (const url of items) {
    const u = String(url);
    if (!/^https?:\/\//i.test(u)) continue;
    if (u.endsWith('.svg')) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
    if (uniq.length >= PREVIEW_LIMIT) break;
  }
  return uniq;
}

// ---------- routes ----------
app.get('/', (req, res) => res.send('API работает!'));

// создание задачи и сбор превью (без очередей)
app.post('/create-pack', async (req, res) => {
  try {
    const { character, topic, style = 'default', slides = 7, chat_id } = req.body || {};
    if (!character || !topic) return res.status(400).json({ error: 'character/topic required' });

    const job_id = crypto.randomUUID();
    const job = { job_id, character, topic, style, slides, chat_id, state:'creating', picks:[], created_at: Date.now() };
    await saveJob(job_id, job);

    console.log(`[final][${now()}] CREATE job=${job_id} char="${character}" topic="${topic}" style="${style}" slides=${slides}`);

    // собираем превью сразу
    let previews = [];
    try {
      previews = await fetchPreviewsSerp({ character, topic, style });
    } catch (e) {
      console.error('[api] serp error:', e?.message);
    }

    if (previews.length) {
      await redis.set(previewsKey(job_id), JSON.stringify(previews), 'EX', 86400);
      job.state = 'preview_ready';
      await saveJob(job_id, job);
      console.log(`[worker] previews ready ${job_id} ${previews.length}`);
    } else {
      job.state = 'error';
      await saveJob(job_id, job);
    }

    res.json({ ok:true, job_id });
  } catch (e) {
    console.error('[api] /create-pack', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/status', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok:false, error:'not found' });
    const previewsRaw = await redis.get(previewsKey(job_id));
    const count = previewsRaw ? (JSON.parse(previewsRaw)?.length || 0) : 0;
    res.json({ ok:true, state: job.state, count });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/previews', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok:false, error:'not found' });
    const raw = await redis.get(previewsKey(job_id));
    res.json({ ok:true, previews: raw ? JSON.parse(raw) : [] });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// finalize → N8N
app.post('/finalize', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[final][${now()}] API /finalize called from ip=${ip} body=`, JSON.stringify(req.body));

    const { job_id, picks = [], want_caption = true } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok:false, error:'not found' });

    if (job.state !== 'preview_ready' && job.state !== 'picking') {
      console.warn(`[final][${now()}] FINALIZE rejected: bad state="${job.state}" job=${job_id}`);
      return res.status(409).json({ ok:false, error:`bad state: ${job.state}` });
    }

    const lockKey = `job:${job_id}:finalize_lock`;
    const gotLock = await redis.set(lockKey, '1', 'NX', 'EX', 600);
    if (!gotLock) { console.warn(`[final][${now()}] FINALIZE duplicate suppressed job=${job_id}`); return res.status(202).json({ ok:true, state: job.state }); }

    const previewsRaw = await redis.get(previewsKey(job_id));
    const previews = previewsRaw ? JSON.parse(previewsRaw) : [];
    if (!previews.length) return res.status(400).json({ ok:false, error:'no previews yet' });

    const uniq = [...new Set((picks||[]).map(n => parseInt(n,10)).filter(n => Number.isInteger(n) && n>=1 && n<=previews.length))];
    const targetCount = job.slides || 7;
    const selected = uniq.slice(0, targetCount).map(n => previews[n-1]);
    if (!selected.length) return res.status(400).json({ ok:false, error:'no valid picks' });

    job.state = 'finalizing';
    job.picks = uniq;
    job.finalize_requested_at = Date.now();
    await saveJob(job_id, job);

    const n8nUrl = process.env.N8N_FINALIZE_URL;
    if (!n8nUrl) return res.status(500).json({ ok:false, error: 'N8N_FINALIZE_URL not set' });

    const payload = {
      job_id,
      character: job.character,
      topic: job.topic,
      style: job.style,
      slides: targetCount,
      want_caption,
      picks: uniq,
      selected,
      callback_url: `${(process.env.BASE_URL || '').replace(/\/+$/,'')}/callback/n8n/final`
    };

    console.log(`[final][${now()}] AUTHORIZED → N8N POST ${n8nUrl}`);
    console.log(`[final][${now()}] payload:`, JSON.stringify({ ...payload, selected_count: selected.length, selected: undefined }, null, 2));
    console.log(`[final][${now()}] selected[0..2]:`, selected.slice(0,3));

    axios.post(n8nUrl, payload, { timeout: 30000 })
      .then(r => console.log(`[final][${now()}] N8N accepted status=${r.status}`))
      .catch(e => console.error(`[final][${now()}] N8N ERROR:`, e?.response?.data || e?.message));

    res.status(202).json({ ok:true, state:'finalizing' });
  } catch (e) {
    console.error('[api] /finalize', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/result', async (req, res) => {
  try {
    const { job_id } = req.query;
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok:false, error:'not found' });
    const raw = await redis.get(finalKey(job_id));
    if (!raw) return res.status(404).json({ ok:false, state: job.state || 'finalizing' });
    const final = JSON.parse(raw);
    res.json({ ok:true, slides: final.slides || [], caption: final.caption || '' });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// колбэк от n8n
app.post('/callback/n8n/final', async (req, res) => {
  try {
    const { job_id, slides = [], caption = '' } = req.body || {};
    const job = await loadJob(job_id);
    if (!job) return res.status(404).json({ ok:false, error:'not found' });

    console.log(`[final][${now()}] ← N8N CALLBACK job=${job_id} slides=${slides.length} caption_len=${(caption||'').length}`);
    console.log(`[final][${now()}] sample slides[0..2]:`, slides.slice(0,3));

    await redis.set(finalKey(job_id), JSON.stringify({ slides, caption }), 'EX', 86400);
    job.state = 'done';
    await saveJob(job_id, job);
    console.log(`[final][${now()}] SAVED final to Redis job=${job_id}`);

    res.json({ ok:true });
  } catch (e) {
    console.error('[api] /callback/n8n/final', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// debug
app.get('/debug/job', async (req, res) => { const { job_id } = req.query; res.json({ job: await loadJob(job_id) }); });
app.get('/debug/final', async (req, res) => { const { job_id } = req.query; const raw = await redis.get(finalKey(job_id)); res.json({ final: raw?JSON.parse(raw):null }); });

module.exports = app;
