// app/lib/search.js
const axios = require('axios');

let gid = 0;

/**
 * Ищем картинки через SerpAPI (Google Images).
 * Возвращаем массив {id,url,thumb,width,height,host,score}
 */
async function searchCandidates({ character, topic = '', count = 60 }) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY missing');
  const q = `${character} aesthetic ${topic}`.trim();

  const { data } = await axios.get('https://serpapi.com/search', {
    params: { engine: 'google_images', q, num: count, api_key: process.env.SERPAPI_KEY },
    timeout: 15000,
  });

  let items = (data.images_results || []).map(v => ({
    id: 'c' + (++gid),
    url: v.original || v.thumbnail,
    thumb: v.thumbnail,
    width: v.width || 0,
    height: v.height || 0,
    host: v.link,
    score: (v.width || 0) * (v.height || 0),
  })).filter(x => x.url);

  // под портрет 4:5 (для инсты) — отсекаем мелкие и «низкие»
  items = items.filter(x => x.width >= 800 && x.height >= 1000);

  // дедуп по URL
  const seen = new Set();
  items = items.filter(x => !seen.has(x.url) && seen.add(x.url));

  // сорт по площади (прокси-качество)
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, count);
}

function rankCandidates(list) {
  // простая рандом-подмешка
  return list.map(x => ({ ...x, score: 0.6 + Math.random() * 0.4 }))
             .sort((a, b) => b.score - a.score);
}

module.exports = { searchCandidates, rankCandidates };
