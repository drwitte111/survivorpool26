// Confidence scoring, plus the weekly flourishes (MVP pick, perfect week,
// hot streak) that hang off it.
import { store, peekWeek } from './state.js';
import { TOTAL_WEEKS } from './data.js';

export function maxPointsFor(week){ return week.games.length; }

export function usedConfidenceValues(week, excludeId){
  const used = new Set();
  week.games.forEach(g => { if(g.id !== excludeId && g.confidence) used.add(g.confidence); });
  return used;
}

export function weekScore(week){
  let earned = 0, possible = 0, gradedCount = 0, correctCount = 0;
  week.games.forEach(g => {
    if(g.confidence) possible += g.confidence;
    if(g.actualWinner){
      gradedCount++;
      if(g.pick && g.pick === g.actualWinner){ earned += (g.confidence||0); correctCount++; }
    }
  });
  return { earned, possible, gradedCount, correctCount, total: week.games.length };
}

export function seasonScore(){
  let earned = 0, possible = 0;
  Object.values(store.state.weeks).forEach(w => {
    const s = weekScore(w);
    earned += s.earned; possible += s.possible;
  });
  return { earned, possible };
}

export function getMvpPick(week){
  let best = null;
  week.games.forEach(g => {
    if(g.actualWinner && g.pick && g.pick === g.actualWinner && g.confidence){
      if(!best || g.confidence > best.confidence) best = g;
    }
  });
  return best;
}
export function isPerfectWeek(week){
  const s = weekScore(week);
  return s.total > 0 && s.gradedCount === s.total && s.correctCount === s.total;
}
export function isWeekFullyGraded(week){ return week.games.length > 0 && week.games.every(g => g.actualWinner); }
export function isWinningWeek(week){ const s = weekScore(week); return s.correctCount > (s.gradedCount - s.correctCount); }
export function computeHotStreak(){
  let n = TOTAL_WEEKS;
  while(n >= 1 && !isWeekFullyGraded(peekWeek(n))) n--;
  let streak = 0;
  while(n >= 1){
    const w = peekWeek(n);
    if(!isWeekFullyGraded(w) || !isWinningWeek(w)) break;
    streak++; n--;
  }
  return streak;
}
