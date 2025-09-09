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

// хорошие / плохие домены
const GOOD_DOMAINS = [
  'pinterest.com','pinimg.com','behance.net','dribbble.com',
  'artstation.com','deviantart.com','tumblr.com','flickr.com',
  'instagram.com','reddit.com'
];
const BAD_DOMAINS = [
  'shutterstock.com','alamy.com','dreamstime.com','depositphotos.com',
  'istockphoto.com','gettyimages.com'
];

function domainOf(url='') {
  try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
}

// формируем поисковый запрос
function buildQuery({ character, topic, style }) {
  const minus = BAD_DOMAINS.map(d => `-site:${d}`).join(' ');
  return `${character} ${topic} ${style} aesthetic instagram pinterest ${minus}`.trim();
}

// tbs: портреты ≥1080×1350
function buildTbs() {
  const parts = [];
  parts.push('itp:photo');   // фото
  parts.push('iar:t');       // tall (портрет)
  parts.push('isz:lt,islt:2mp'); // >2 мегапикселя (~минимум 1080×1350)
  return parts.join(',');
}

// качаем несколько страниц
async function fetchSerpImages(query, needed = 25, tbs) {
  const pages = [0, 1, 2, 3];
  const all = [];
  for (const ijn of pages) {
    const params = {
      engine: 'google',
      q: query,
      tbm: 'isch',
      ijn: String(ijn),
      api_key: process.env.SERPAPI_KEY,
      safe: process.env.SERPAPI_SAFE || 'active',
      hl: process.env.SERPAPI_HL || 'en',
      gl: process.env.SERPAPI_GL || 'us',
      tbs
    };
    const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 20000 });
    const chunk = Array.isArray(data?.images_results) ? data.images_results : [];
    all.push(...chunk);
    if (all.length >= needed * 3) break;
  }
  return all;
}

// скоринг
function scoreImage(it) {
  const url = it.original || it.thumbnail || it.link || it.image || '';
  const d = domainOf(url);
  const w = Number(it.original_width || it.width || 0);
  const h = Number(it.original_height || it.height || 0);
  const mp = (w*h)/1e6;

  let s = 0;
  s += Math.min(mp, 20) * 2;
  // приоритет вертикальных ≥1080×1350
  if (w >= 1080 && h >= 1350 && h > w) s += 20;
  if (w >= 1600 && h >= 2000) s += 10;

  if (GOOD_DOMAINS.some(x => d.endsWith(x))) s += 10;
  if (BAD_DOMAINS.some(x => d.endsWith(x)))  s -= 20;
  if (w < 600 || h < 800) s -= 10;

  return { url, s, w, h, d };
}

// выбор лучших
function pickImages(images, limit = 25) {
  const seen = new Set();
  const scored = images
    .map(scoreImage)
    .filter(x => x.url && x.url.startsWith('https://'))
    .sort((a,b) => b.s - a.s);

  const out = [];
  for (const x of scored) {
    const k = x.url.split('?')[0];
    if (seen.has(k)) continue;
    const sameDomain = out.filter(o => o.includes(x.d)).length;
    if (sameDomain >= 8) continue;
    seen.add(k);
    out.push(x.url);
    if (out.length >= limit) break;
  }
  return out;
}

// worker
new Worker(queueName, async (job) => {
  if (job.name !== 'build-previews') return;

  const { job_id, character, topic, style } = job.data || {};
  const j = await loadJob(job_id);
  if (!j) return;

  try {
    const query = buildQuery({ character, topic, style });
    const tbs = buildTbs();

    const candidates = await fetchSerpImages(query, 25, tbs);
    const previews   = pickImages(candidates, 25);

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
