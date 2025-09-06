// app/server.js
const express = require('express');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const cloudinary = require('cloudinary').v2;

const app = express();

// Redis соединение
const redis = new IORedis(process.env.REDIS_URL);
redis.on('connect', () => console.log('[api] Redis connected'));
redis.on('error', (e) => console.error('[api] Redis error', e?.message));

// Очередь (имя ДОЛЖНО совпадать с именем в worker.js)
const queueName = 'sigma-jobs';
const queue = new Queue(queueName, { connection: redis });

// Cloudinary из CLOUDINARY_URL (ключ/секрет возьмутся автоматически)
cloudinary.config(true);

// 1) Healthcheck API
app.get('/', (req, res) => {
  res.send('API работает!');
});

// 2) Проверка Redis (PING)
app.get('/health/redis', async (req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, pong });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 3) Поставить тест-задачу в очередь (worker должен залогировать)
app.get('/health/queue', async (req, res) => {
  try {
    const job = await queue.add('test', { ts: Date.now() });
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4) Тест Cloudinary — грузим публичную картинку и возвращаем URL
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
