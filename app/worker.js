// app/worker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL);
connection.on('connect', () => console.log('[worker] Redis connected'));
connection.on('error', (e) => console.error('[worker] Redis error', e?.message));

const queueName = 'sigma-jobs';

const worker = new Worker(queueName, async (job) => {
  console.log(`[worker] processing job ${job.id}`, job.name, job.data);
}, { connection });

worker.on('ready', () => console.log(`[worker] listening queue "${queueName}"`));
worker.on('failed', (job, err) => console.error('[worker] job failed', job?.id, err?.message));
