// app/lib/store.js
const IORedis = require('ioredis');

const redisOpts = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: { rejectUnauthorized: false },
};

const redis = new IORedis(process.env.REDIS_URL, redisOpts);

const kJob   = id => `job:${id}`;
const kPicks = id => `picks:${id}`;
const JOB_TTL = 60 * 60 * 24 * 7; // 7 дней

async function createJobRecord(id, { chat_id, character, topic, style, slides }) {
  await redis.hset(kJob(id), {
    state: 'collecting',
    chat_id: String(chat_id || ''),
    character: character || '',
    topic: topic || '',
    style: style || 'default',
    slides: String(slides || 7),
    created_at: new Date().toISOString(),
  });
  await redis.expire(kJob(id), JOB_TTL);
}

async function setPreview(id, arr, limit = 7) {
  await redis.hset(kJob(id), {
    state: 'preview_ready',
    preview_json: JSON.stringify(arr),
    limit_pick: String(limit),
  });
  await redis.expire(kJob(id), JOB_TTL);
}

async function getStatus(id) {
  const h = await redis.hgetall(kJob(id));
  if (!h.state) return { state: 'queued' };
  const preview = h.preview_json ? JSON.parse(h.preview_json) : undefined;
  const picks_count = await redis.scard(kPicks(id));
  return {
    state: h.state,
    character: h.character,
    topic: h.topic,
    style: h.style,
    slides: Number(h.slides || 7),
    preview,
    limit_pick: Number(h.limit_pick || 7),
    picks_count,
  };
}

async function getPreview(id) {
  const j = await redis.hget(kJob(id), 'preview_json');
  return j ? JSON.parse(j) : [];
}

async function togglePick(id, n) {
  const key = kPicks(id), m = String(n);
  const ex = await redis.sismember(key, m);
  ex ? await redis.srem(key, m) : await redis.sadd(key, m);
  await redis.expire(key, JOB_TTL);
  return await redis.scard(key);
}

async function getPicks(id) {
  return (await redis.smembers(kPicks(id))).map(Number).sort((a, b) => a - b);
}

module.exports = {
  redis,
  createJobRecord,
  setPreview,
  getStatus,
  getPreview,
  togglePick,
  getPicks,
};
