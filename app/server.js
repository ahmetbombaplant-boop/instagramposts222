// app/server.js
const express = require('express');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const cloudinary = require('cloudinary').v2;

const app = express();

// Redis
const redis = new IORedis(process.env.REDIS_URL);
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', (e) => console.error('[api] Redis error', e?.message));

// Queue
const queueName = 'sigma-jobs';
const queue = new Queue(queueName, { connection: redis });

// Cloudinary
cloudinary.config(true);

// Routes
app.get('/', (req, res) => res.send('API работает!'));

app.get('/health/redis', async (req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, pong });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
  try {
    const r = await cloudinary.uploader.upload(
      'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      { folder: 'sigma-test' }
    );
    res.json({ ok: true, secure_url: r.secure_url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = app;   // <--- ВАЖНО: только экспортируем app, без listen()
