import 'dotenv/config';
import { Worker } from 'bullmq';
import { createJobRecord, setPreview } from './lib/store.js';
import { searchCandidates } from './lib/search.js';
import { rankCandidates } from './lib/rank.js';

const connection = { connection:{ url: process.env.REDIS_URL } };

// Воркер принимает job, ищет 60 кандидатов, отдаёт топ-15 для выбора
new Worker('packs', async job=>{
  const { character, topic, style, slides, chat_id } = job.data;

  await createJobRecord(job.id,{ chat_id, character, topic, style, slides });

  const found   = await searchCandidates({ character, topic, count:60 });
  const preview = rankCandidates(found).slice(0,15);

  await setPreview(job.id, preview, slides||7);
}, connection);
