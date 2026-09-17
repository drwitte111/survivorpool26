// An automated "Commissioner" recap, posted to the Trash Talk board once a
// week is fully decided: who topped the week, who bottomed it, the biggest
// blown high-confidence pick, and (when it happened) the week's Survivor
// casualty and its biggest upset. Posted as "Roger Goodell" so it reads as a
// league-office memo rather than another member's post.
//
// There's no server here, so "funny and different every week" can't mean an
// LLM call -- that would need an API key shipped to the browser, which is
// exactly the kind of secret this app is built never to hold. Instead this
// picks from a bank of hand-written lines for each beat (open, praise the
// top score, roast the bottom, call out the blown pick, ...) and fills in
// the real numbers, so the shape varies a lot even though the raw material
// doesn't change week to week.
//
// Posting is gated to an admin's client and written through a transaction
// keyed by week number, so two admin sessions noticing the same finished
// week at once still produce exactly one post, not a duplicate.
import { store, getWeek } from './state.js';
import { db } from './firebase.js';
import { TOTAL_WEEKS } from './data.js';
import { isWeekFinished } from './refresh.js';
import { gradedWinner, sharedSpread } from './scoring.js';
import { gamePickKey, fetchLeagueTeams } from './league.js';
import { reconcileMember } from './reconcile.js';
import { teamNickname } from './teams.js';
import { isAdmin } from './roles.js';

const COMMISSIONER_NAME = 'Roger Goodell';

function joinNames(names){
  if(names.length <= 1) return names[0] || '';
  if(names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function pick(bank){
  return bank[Math.floor(Math.random() * bank.length)];
}

/** The highest-confidence pick anyone got wrong this week, or null. */
function findWorstPick(n, week, teams){
  let worst = null;
  teams.forEach(t => {
    const weekPicks = t.picks && t.picks[n];
    if(!weekPicks) return;
    week.games.forEach(g => {
      const entry = weekPicks[gamePickKey(g)];
      if(!entry || !entry.p) return;
      const line = entry.s != null ? entry.s : sharedSpread(g);
      const winner = gradedWinner(g, line);
      if(!winner || winner === 'push' || entry.p === winner) return; // correct or push
      const confidence = entry.c || 0;
      if(!worst || confidence > worst.confidence){
        worst = {
          teamName: t.teamName,
          confidence,
          pickedTeam: teamNickname(entry.p === 'home' ? g.home : g.away),
          opponent: teamNickname(entry.p === 'home' ? g.away : g.home),
        };
      }
    });
  });
  return worst;
}

/** The favourite that lost by the widest margin against the spread, or null. */
function findBiggestUpset(week){
  let upset = null;
  week.games.forEach(g => {
    if(g.homeSpread == null || !g.actualWinner) return;
    const favSide = g.homeSpread < 0 ? 'home' : (g.homeSpread > 0 ? 'away' : null);
    if(!favSide || g.actualWinner === favSide) return;
    const magnitude = Math.abs(g.homeSpread);
    if(!upset || magnitude > upset.magnitude){
      upset = {
        magnitude,
        winner: teamNickname(g.actualWinner === 'home' ? g.home : g.away),
        loser: teamNickname(g.actualWinner === 'home' ? g.away : g.home),
      };
    }
  });
  return upset;
}

/** Everything the post needs to know about week n, or null if nobody played it. */
function buildWeekFacts(n, teamsRaw){
  const week = getWeek(n);
  const teams = teamsRaw.map(reconcileMember);

  const engaged = teams.filter(t => t.picks && t.picks[n] && Object.keys(t.picks[n]).length);
  if(!engaged.length) return null;

  const ranked = engaged
    .map(t => ({ teamName: t.teamName, pts: (t.weeklyPoints && t.weeklyPoints[n]) || 0 }))
    .sort((a, b) => b.pts - a.pts);
  const topPts = ranked[0].pts;
  const bottomPts = ranked[ranked.length - 1].pts;
  const topScorers = ranked.filter(r => r.pts === topPts).map(r => r.teamName);
  const bottomScorers = (ranked.length > 1 && bottomPts !== topPts)
    ? ranked.filter(r => r.pts === bottomPts).map(r => r.teamName) : [];

  return {
    topScorers, topPts,
    bottomScorers, bottomPts,
    worstPick: findWorstPick(n, week, teamsRaw),
    biggestUpset: findBiggestUpset(week),
    casualties: teams.filter(t => t.survivorEliminatedWeek === n),
  };
}

const OPENERS = [
  (n) => `Hey everyone, Commissioner Roger Goodell here with your Week ${n} report.`,
  (n) => `Roger Goodell, League Office, checking in after Week ${n}.`,
  (n) => `This is your commissioner, Roger Goodell, back with the Week ${n} rundown.`,
  (n) => `Week ${n} is in the books. Commissioner Goodell has some thoughts.`,
  (n) => `Greetings from the league office. Week ${n} has been reviewed, and I have notes.`,
];

const TOP_LINES = [
  (top, pts) => `Good work to ${top} on being the smartest ${pts === 1 ? 'person' : 'people'} this week — ${pts} points.`,
  (top, pts) => `${top} put up ${pts} points this week. I'd fine everyone else for not paying attention, but I don't have that authority. Yet.`,
  (top, pts) => `Take a bow, ${top} — ${pts} points is the kind of week that gets you a game ball, if I gave those out.`,
  (top, pts) => `${top} ran away with the week, ${pts} points and all. The rest of you, take notes.`,
  (top, pts) => `The league office would like to congratulate ${top} on ${pts} points. Everybody else, your excuses have been received. They were not persuasive.`,
];

const BOTTOM_LINES = [
  (bottom, pts) => `Tough luck, ${bottom} — maybe try picking with your brain instead of your heart next time.`,
  (bottom, pts) => `Tough week, ${bottom}. ${pts} points is the kind of performance that gets a coach's Twitter mentions turned off.`,
  (bottom, pts) => `${bottom} finished the week with ${pts} points. I've seen preseason box scores with more conviction.`,
  (bottom, pts) => `Somewhere, ${bottom}'s bracket is filing a formal grievance with the league office.`,
  (bottom, pts) => `${bottom} put up ${pts} points this week. Good news: there's nowhere to go but up. Probably.`,
];

// Real team names in these get run through teamNickname() before they hit a
// template -- "the Cardinals upsetting the Chargers" reads like someone
// actually watched the game; "Arizona Cardinals over Los Angeles Chargers"
// reads like a scoreboard ticker.
const WORST_PICK_LINES = [
  (w) => `Special mention to ${w.teamName}, who put ${w.confidence} points on the ${w.pickedTeam} against the ${w.opponent}. That did not age well.`,
  (w) => `${w.teamName} went all in on the ${w.pickedTeam} this week, ${w.confidence} points and all. The ${w.opponent} had other plans. The league office feels your pain.`,
  (w) => `Somewhere out there, ${w.teamName} is still wondering where that ${w.confidence}-point pick on the ${w.pickedTeam} went wrong. Say hi to the ${w.opponent} on your way out.`,
  (w) => `A moment of silence for ${w.teamName}'s ${w.confidence}-point pick on the ${w.pickedTeam}. It did not survive the ${w.opponent}.`,
  (w) => `Bold of ${w.teamName} to put ${w.confidence} points on the ${w.pickedTeam} this week. The ${w.opponent} said no thanks.`,
];

const UPSET_LINES = [
  (u) => `Also worth noting: the ${u.winner} upsetting the ${u.loser} was not on anyone's bingo card.`,
  (u) => `The ${u.winner} over the ${u.loser} was the kind of result that ruins confidence boards league-wide.`,
  (u) => `Nobody had the ${u.winner} beating the ${u.loser}. Vegas isn't thrilled either.`,
  (u) => `The ${u.loser} losing to the ${u.winner} is going to sting for a few of you.`,
];

// `team` already carries its own article -- "the Cardinals" or, with nothing
// published to name, "their lock" -- so the templates below don't add one.
const CASUALTY_LINES = [
  (name, team) => `And in Survivor news: ${name} is officially out after riding ${team} a week too far. The league observes a moment of silence.`,
  (name, team) => `Survivor claimed another victim this week: ${name}, eliminated after ${team} came up short.`,
  (name, team) => `RIP to ${name}'s Survivor run, done in by ${team}.`,
];

const SIGNOFFS = [
  'See everyone next week. — Commissioner Roger Goodell',
  'Keep it clean out there. — Roger Goodell, Commissioner',
  "That's all for this week. — The Commissioner",
  '— R. Goodell',
];

export function composeCommissionerPost(n, facts){
  const lines = [pick(OPENERS)(n), ''];

  lines.push(pick(TOP_LINES)(joinNames(facts.topScorers), facts.topPts));

  if(facts.bottomScorers.length){
    lines.push(pick(BOTTOM_LINES)(joinNames(facts.bottomScorers), facts.bottomPts));
  }

  if(facts.worstPick){
    lines.push(pick(WORST_PICK_LINES)(facts.worstPick));
  }

  if(facts.biggestUpset){
    lines.push(pick(UPSET_LINES)(facts.biggestUpset));
  }

  facts.casualties.forEach(t => {
    const team = t.survivorEliminatedTeam ? 'the ' + teamNickname(t.survivorEliminatedTeam) : 'their lock';
    lines.push(pick(CASUALTY_LINES)(t.teamName, team));
  });

  lines.push('', pick(SIGNOFFS));
  return lines.join('\n');
}

async function postIfMissing(n, teams){
  const slug = store.state.account.leagueSlug;
  const facts = buildWeekFacts(n, teams);
  if(!facts) return; // nobody played this week -- nothing to say

  const ref = db.collection('leagues').doc(slug).collection('trashtalk').doc('commissioner-week' + n);
  const message = composeCommissionerPost(n, facts);

  // A transaction, not a plain get-then-set: two admin sessions noticing the
  // same finished week within a moment of each other must still land exactly
  // one post, not a coin-flip duplicate.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if(snap.exists) return;
    tx.set(ref, {
      teamName: COMMISSIONER_NAME,
      commissioner: true,
      week: n,
      message,
      postedAt: new Date().toISOString(),
    });
  });
}

/**
 * Posts a recap for any week that's fully finished and doesn't have one yet.
 * Admin-only -- the league already trusts the admin's client as the source of
 * truth for spreads and results, and gating this the same way means no two
 * ordinary members' clients can race to post it.
 */
export async function checkAndPostWeeklyRecaps(){
  if(!isAdmin()) return;
  if(!store.state.account.leagueSlug) return;
  let teams;
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const week = getWeek(n);
    if(!isWeekFinished(week)) continue;
    try{
      if(!teams) teams = await fetchLeagueTeams(); // fetched once, only if needed
      await postIfMissing(n, teams);
    }catch(e){
      console.warn('commissioner recap failed for week', n, e.message);
    }
  }
}
