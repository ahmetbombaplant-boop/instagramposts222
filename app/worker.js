// app/worker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { setPreview } = require('./lib/store');
const { searchCandidates, rankCandidates } = require('./lib/search');

const queueName = 'sigma-jobs';

const redisOpts = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: { rejectUnauthorized: false },
};
const connection = new IORedis(process.env.REDIS_URL, redisOpts);

connection.on('connect', () => console.log('[worker] Redis connected'));
connection.on('error', (e) => console.error('[worker] Redis error', e?.message));

const worker = new Worker(queueName, async (job) => {
  if (job.name === 'test') {
    console.log('[worker] test job', job.id, job.data);
    return;
  }

  if (job.name === 'pack:collect') {
    const { character, topic, slides } = job.data;
    const found = await searchCandidates({ character, topic, count: 60 });
    const preview = rankCandidates(found).slice(0, 15);
    await setPreview(job.id, preview, slides || 7);
    console.log('[worker] preview ready for', job.id, 'items:', preview.length);
    return;
  }

  console.log('[worker] unknown job', job.name);
}, { connection });

worker.on('ready', () => console.log(`[worker] listening queue "${queueName}"`));
worker.on('failed', (job, err) => console.error('[worker] job failed', job?.id, err?.message));
