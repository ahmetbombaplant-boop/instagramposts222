import { redis, kJob, kPicks, kRecent } from './redis.js';

const JOB_TTL=60*60*24*7;     // 7 дней
const RECENT_TTL=60*60*24*14; // 14 дней

export async function createJobRecord(id,{chat_id,character,topic,style,slides}){
  await redis.hset(kJob(id),{
    state:'collecting',
    chat_id:String(chat_id||''),
    character, topic, style,
    slides:String(slides||7),
    created_at:new Date().toISOString()
  });
  await redis.expire(kJob(id),JOB_TTL);
}

export async function setPreview(id,arr,limit=7){
  await redis.hset(kJob(id),{
    state:'preview_ready',
    preview_json:JSON.stringify(arr),
    limit_pick:String(limit)
  });
  await redis.expire(kJob(id),JOB_TTL);
}

export async function getStatus(id){
  const h=await redis.hgetall(kJob(id));
  if(!h.state) return {state:'queued'};
  const preview=h.preview_json?JSON.parse(h.preview_json):undefined;
  const picks_count=await redis.scard(kPicks(id));
  return {
    state:h.state,
    character:h.character,
    topic:h.topic,
    style:h.style,
    slides:Number(h.slides||7),
    preview,
    limit_pick:Number(h.limit_pick||7),
    picks_count
  };
}

export async function getPreview(id){
  const j=await redis.hget(kJob(id),'preview_json');
  return j?JSON.parse(j):[];
}

export async function togglePick(id,n){
  const key=kPicks(id), m=String(n);
  const ex=await redis.sismember(key,m);
  ex?await redis.srem(key,m):await redis.sadd(key,m);
  await redis.expire(key,JOB_TTL);
  return await redis.scard(key);
}

export async function getPicks(id){
  return (await redis.smembers(kPicks(id))).map(Number).sort((a,b)=>a-b);
}

export async function markRecent(character,urls){
  if(!character||!urls?.length) return;
  const key=kRecent(character);
  await redis.sadd(key,...urls);
  await redis.expire(key,RECENT_TTL);
}

export async function filterNotRecent(character,items){
  if(!character||!items?.length) return items;
  const key=kRecent(character);
  const out=[];
  for(const it of items){
    const url=it.url||it.contentUrl; if(!url) continue;
    const used=await redis.sismember(key,url);
    if(!used) out.push(it);
  }
  return out;
}
