import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { togglePick, getPicks } from './lib/store.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN,{ polling:true });
const api=(p,d)=>axios.post(`${process.env.BASE_URL}${p}`,d).then(r=>r.data);
const get=p=>axios.get(`${process.env.BASE_URL}${p}`).then(r=>r.data);

const S=new Map();

// старт
bot.onText(/^\/start|^\/new$/, async msg=>{
  const id=msg.chat.id; S.set(id,{step:'character'});
  bot.sendMessage(id,'Персонаж? (например: Leonardo DiCaprio)');
});

// шаги диалога
bot.on('message', async msg=>{
  const id=msg.chat.id, s=S.get(id); if(!s) return;
  if(s.step==='character'){
    s.character=msg.text.trim();
    s.step='topic';
    return bot.sendMessage(id,'Тема? (коротко)');
  }
  if(s.step==='topic'){
    s.topic=msg.text.trim();
    s.step='style';
    return bot.sendMessage(id,'Стиль? (wolf-blue)');
  }
  if(s.step==='style'){
    s.style=(msg.text.trim()||'wolf-blue');
    s.step='wait';
    bot.sendMessage(id,`Собираю 15 под ${s.character}/${s.topic}…`);
    const { job_id }=await api('/create-pack',{ character:s.character, topic:s.topic, style:s.style, slides:7, chat_id:id });
    s.job_id=job_id;
    const t=setInterval(async ()=>{
      const st=await get(`/status?job_id=${job_id}`);
      if(st.state==='preview_ready'){ clearInterval(t); bot.sendMessage(id,'Готово: 15 превью. Пиши цифры 1..15, /rec — авто 7, /final — завершить.'); }
    },1500);
  }
});

// авто-рекоммендация
bot.onText(/^\/rec$/, async msg=>{
  const id=msg.chat.id, s=S.get(id); if(!s?.job_id) return;
  const st=await get(`/status?job_id=${s.job_id}`); if((st.preview||[]).length<7) return;
  const prev=await getPicks(s.job_id); for(const n of prev) await togglePick(s.job_id,n);
  for(let i=1;i<=7;i++) await togglePick(s.job_id,i);
  bot.sendMessage(id,'Рекомендовал 7/7. Жми /final');
});

// финализация
bot.onText(/^\/final$/, async msg=>{
  const id=msg.chat.id, s=S.get(id); if(!s?.job_id) return;
  const picks=await getPicks(s.job_id);
  if(picks.length!==7) return bot.sendMessage(id,`Нужно 7, выбрано ${picks.length}`);
  const out=await api('/finalize',{ job_id:s.job_id, picks, want_caption:true });
  for(const url of out.slides) await bot.sendPhoto(id,url);
  bot.sendMessage(id,`Подпись:\n${out.caption}`);
});

// выбор цифрой 1..15
bot.on('text', async msg=>{
  const id=msg.chat.id, s=S.get(id); if(!s?.job_id) return;
  const n=parseInt(msg.text,10);
  if(!Number.isInteger(n)||n<1||n>15) return;
  const c=await togglePick(s.job_id,n);
  bot.sendMessage(id,`Выбрано ${c}/7`);
});
