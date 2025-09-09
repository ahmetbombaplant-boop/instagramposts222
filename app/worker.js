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

// домены
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

function buildQuery({ character, topic, style }) {
  const minus = BAD_DOMAINS.map(d => `-site:${d}`).join(' ');
  return `${character} ${topic} ${style} aesthetic instagram pinterest ${minus}`.trim();
}

// разные профили фильтров (от строгого к мягкому)
function tbsProfiles() {
  const profiles = [];

  // P1: портрет, «крупные» (примерно ≥1080x1350)
  profiles.push('itp:photo,iar:t,isz:lt,islt:2mp');

  // P2: портрет, без min-size
  profiles.push('itp:photo,iar:t');

  // P3: только фото, без ratio
  profiles.push('itp:photo');

  // P4: вообще без tbs (максимально мягко)
  profiles.push('');

  return profiles;
}

async function fetchSerpImagesWithFallback(query, needed = 25) {
  const pages = [0,1,2,3,4]; // до 5 страниц
  const profiles = tbsProfiles();
  let collected = [];
  let usedProfile = null;

  for (const tbs of profiles) {
    let batch = [];
    for (const ijn of pages) {
      const params = {
        engine: 'google',
        q: query,
        tbm: 'isch',
        ijn: String(ijn),
        api_key: process.env.SERPAPI_KEY,
        safe: process.env.SERPAPI_SAFE || 'active',
        hl: process.env.SERPAPI_HL || 'en',
        gl: process.env.SERPAPI_GL || 'us'
      };
      if (tbs) params.tbs = tbs;

      try {
        const { data } = await axios.get('https://serpapi.com/search.json', { params, timeout: 25000 });
        if (data?.error) {
          throw new Error(data.error);
        }
        const chunk = Array.isArray(data?.images_results) ? data.images_results : [];
        batch.push(...chunk);
        if (batch.length >= needed * 3) break; // достаточно кандидатов
      } catch (e) {
        // пробросим только если вообще ничего не собрали по всем профилям
        console.error('[worker] serpapi error', e?.message);
        // если это rate-limit — не ломаем цикл сразу
      }
    }
    console.log(`[worker] serp candidates with tbs="${tbs || 'none'}":`, batch.length);
    if (batch.length) {
      collected = batch;
      usedProfile = tbs || 'none';
      break;
    }
  }

  return { collected, usedProfile };
}

function scoreImage(it) {
  const url = it.original || it.thumbnail || it.link || it.image || '';
  const d = domainOf(url);
  const w = Number(it.original_width || it.width || 0);
  const h = Number(it.original_height || it.height || 0);
  const mp = (w*h)/1e6;

  let s = 0;
  s += Math.min(mp, 20) * 2;

  // instagram portrait приоритет
  if (h > w && w >= 1080 && h >= 1350) s += 20;
  if (w >= 1600 && h >= 2000) s += 10;

  if (GOOD_DOMAINS.some(x => d.endsWith(x))) s += 10;
  if (BAD_DOMAINS.some(x => d.endsWith(x)))  s -= 20;

  if (w < 600 || h < 800) s -= 12;

  return { url, s, w, h, d };
}

function pickImages(images, limit = 25) {
  const seen = new Set();
  const scored = images
    .map(scoreImage)
    .filter(x => x.url && x.url.startsWith('https://'))
    .sort((a,b) => b.s - a.s);

  const out = [];
  const perDomainCap = 8;

  for (const x of scored) {
    const k = x.url.split('?')[0];
    if (seen.has(k)) continue;
    const sameDomain = out.filter(o => o.includes(x.d)).length;
    if (sameDomain >= perDomainCap) continue;
    seen.add(k);
    out.push(x.url);
    if (out.length >= limit) break;
  }
  return out;
}

new Worker(queueName, async (job) => {
  if (job.name !== 'build-previews') return;

  const { job_id, character, topic, style } = job.data || {};
  const j = await loadJob(job_id);
  if (!j) return;

  try {
    const query = buildQuery({ character, topic, style });

    const { collected, usedProfile } = await fetchSerpImagesWithFallback(query, 25);
    if (!collected.length) throw new Error('SerpAPI returned 0 images (check key/quota/tbs)');

    const previews = pickImages(collected, 25);
    if (!previews.length) throw new Error('no images passed filters');

    await redis.set(previewsKey(job_id), JSON.stringify(previews), 'EX', 60 * 60 * 24);

    j.state = 'preview_ready';
    j.meta = { used_tbs: usedProfile, candidates: collected.length };
    await saveJob(job_id, j);

    console.log('[worker] previews ready', job_id, previews.length, 'tbs:', usedProfile);
  } catch (e) {
    j.state = 'error';
    j.error = e?.message || 'unknown';
    await saveJob(job_id, j);
    console.error('[worker] build-previews failed', job_id, e?.message);
  }
}, { connection: redis, concurrency: 3 });

console.log('[worker] listening queue', queueName);
