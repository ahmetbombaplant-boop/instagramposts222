import 'dotenv/config';
import express from 'express';
import { Queue } from 'bullmq';
import { getStatus, getPreview, getPicks, markRecent } from './lib/store.js';
import { renderFinalSlides } from './lib/render.js';
import { genCaption } from './lib/textgen.js';

const app = express();
app.use(express.json());

const q = new Queue('packs', { connection:{ url: process.env.REDIS_URL } });

// создать задачу
app.post('/create-pack', async (req,res)=>{
  const { character, topic, style='wolf-blue', slides=7, chat_id='' }=req.body||{};
  const job = await q.add('pack',{ character, topic, style, slides, chat_id });
  res.json({ job_id: job.id });
});

// статус
app.get('/status', async (req,res)=>{
  res.json(await getStatus(req.query.job_id));
});

// финализация
app.post('/finalize', async (req,res)=>{
  const { job_id, picks=[], want_caption=true, schedule="now" }=req.body||{};
  const st = await getStatus(job_id);
  if(st.state!=='preview_ready') return res.status(400).json({error:'no preview'});

  const idx = picks.length? picks : (await getPicks(job_id));
  if(idx.length!==st.limit_pick)
    return res.status(400).json({error:`need ${st.limit_pick} picks, have ${idx.length}`});

  const preview  = await getPreview(job_id);
  const selected = idx.map(n=>preview[n-1]);

  const slides  = await renderFinalSlides(selected);
  const caption = want_caption? await genCaption(selected):'';

  await markRecent(st.character, selected.map(s=>s.url));

  // если задан вебхук n8n — уведомим для автопубликации
  if(process.env.N8N_FINALIZE_WEBHOOK){
    try {
      await fetch(process.env.N8N_FINALIZE_WEBHOOK,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ job_id, images:slides, caption, schedule })
      });
    } catch(e){}
  }

  res.json({ state:'done', slides, caption });
});

app.get('/',(_,res)=>res.send('OK'));
app.listen(process.env.PORT||3000,()=>console.log('API on',process.env.PORT||3000));
