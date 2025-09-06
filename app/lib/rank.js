// простейший ранкер — рандомный скор сверху, чтобы перемешать
export function rankCandidates(list){
  return list.map(x=>({...x,score:0.6+Math.random()*0.4}))
             .sort((a,b)=>b.score-a.score);
}
