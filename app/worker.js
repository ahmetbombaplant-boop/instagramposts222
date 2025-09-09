const IORedis = require('ioredis');
const axios = require('axios');
const { Worker } = require('bullmq');

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('connect', () => console.log('[worker] Redis connected'));
redis.on('error', e => console.error('[worker] Redis error', e?.message));

const queueName = 'sigma-jobs';

const jobKey      = id => `job:${id}`;
const previewsKey = id => `job:${id}:previews`;

async function loadJob(id) {
  const raw = await redis.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveJob(id, payload) {
  await redis.set(jobKey(id), JSON.stringify(payload), 'EX', 60 * 60 * 24);
}

function buildQuery({ character, topic, style }) {
  const parts = [character, topic, style].filter(Boolean).join(' ');
  // эстетичный подбор: подмешиваем контекст
  return `${parts} aesthetic reference pinterest style photography`;
}

function pickImages(images, limit = 15) {
  const seen = new Set();
  const result = [];
  for (const img of images) {
    const url = img.original || img.thumbnail || img.link || img.image;
    if (!url) continue;
    const key = url.split('?')[0]; // грубая дедупликация
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url.replace(/^http:\/\//i, 'https://'));
    if (result.length >= limit) break;
  }
  return result;
}

async function fetchSerpImages(query) {
  const params = {
    engine: 'google',
    q: query,
    tbm: 'isch',
    ijn: '0',
    api_key: process.env.SERPAPI_KEY,
    safe: process.env.SERPAPI_SAFE || 'active',
    hl: process.env.SERPAPI_HL || 'en',
    gl: process.env.SERPAPI_GL || 'us'
  };
  const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 20000 });
  return Array.isArray(data?.images_results) ? data.images_results : [];
}

new Worker(queueName, async (job) => {
  if (job.name !== 'build-previews') return;

  const { job_id, character, topic, style } = job.data || {};
  const j = await loadJob(job_id);
  if (!j) {
    console.warn('[worker] job record not found', job_id);
    return;
  }

  try {
    const query = buildQuery({ character, topic, style });
    const images = await fetchSerpImages(query);
    const previews = pickImages(images, 15);

    if (!previews.length) throw new Error('no images found');

    await redis.set(previewsKey(job_id), JSON.stringify(previews), 'EX', 60 * 60 * 24);

    j.state = 'preview_ready';
    await saveJob(job_id, j);

    console.log('[worker] previews ready', job_id, previews.length);
  } catch (e) {
    j.state = 'error';
    j.error = e?.message || 'unknown';
    await saveJob(job_id, j);
    console.error('[worker] build-previews failed', job_id, e?.message);
  }
}, { connection: redis, concurrency: 3 });

console.log('[worker] listening queue', queueName);
