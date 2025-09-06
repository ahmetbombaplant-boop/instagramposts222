// app/worker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');

const queueName = 'sigma-jobs';

// ВАЖНО: опции для BullMQ + Upstash
const redisOpts = {
  maxRetriesPerRequest: null,   // <-- требование BullMQ
  enableReadyCheck: false,      // <-- рекомендуют для Upstash
  tls: { rejectUnauthorized: false } // Upstash TLS
};

// Один коннект для воркера
const connection = new IORedis(process.env.REDIS_URL, redisOpts);
connection.on('connect', () => console.log('[worker] Redis connected'));
connection.on('error', (e) => console.error('[worker] Redis error', e?.message));

// Запускаем воркер
const worker = new Worker(
  queueName,
  async (job) => {
    console.log(`[worker] processing job ${job.id}`, job.name, job.data);
  },
  { connection } // передаём IORedis instance с нужными опциями
);

worker.on('ready', () => console.log(`[worker] listening queue "${queueName}"`));
worker.on('failed', (job, err) => console.error('[worker] job failed', job?.id, err?.message));
