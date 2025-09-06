import axios from 'axios';
import { filterNotRecent } from './store.js';

let id=0;

/**
 * Возвращает до `count` кандидатов из Google Images (через SerpAPI)
 * с базовой фильтрацией под формат 1080x1350.
 */
export async function searchCandidates({ character, topic='', count=60 }) {
  if(!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY is missing');

  const q = `${character} aesthetic ${topic}`.trim();

  const { data } = await axios.get('https://serpapi.com/search', {
    params: { engine:'google_images', q, num: count, api_key: process.env.SERPAPI_KEY },
    timeout: 15000
  });

  let items = (data.images_results||[]).map(v => ({
    id:'c'+(++id),
    url: v.original || v.thumbnail,
    thumb: v.thumbnail,
    width: v.width||0,
    height: v.height||0,
    host: v.link,
    score: (v.width||0)*(v.height||0)
  })).filter(x=>x.url);

  // отбрасываем мелкое и слишком «квадратное» под портрет 4:5
  items = items.filter(x=>x.width>=800 && x.height>=1000);

  // дедуп по URL
  const seen=new Set(); items = items.filter(x=>!seen.has(x.url) && seen.add(x.url));

  // не повторять свежие для этого персонажа
  items = await filterNotRecent(character, items);

  // сортировка по площади (как грубый признак качества)
  items.sort((a,b)=>b.score-a.score);
  return items.slice(0,count);
}
