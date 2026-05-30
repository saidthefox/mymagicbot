'use strict';
// Sanctioned-style Swiss pairing engine. Pure functions, no Discord deps, so it is unit-testable.
//
// Match points: win 3, draw 1, loss 0, bye 3 (treated as a 2-0 win for the player's own record,
// but the (nonexistent) bye opponent is excluded from opponents' tiebreakers).
// Results are best-of-3 reported as: '2' (2-0 win), '3' (2-1 win), '0' (draw, recorded as 1-1 games).

const MP_WIN = 3;
const MP_DRAW = 1;
const FLOOR = 1 / 3;

// ---- internal helpers -------------------------------------------------------

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Turn a reported match into game/match record for both players.
// code: '2' winner 2-0, '3' winner 2-1, '0' draw.
function matchRecord(code) {
  switch (String(code)) {
    case '2': return { winnerGames: 2, loserGames: 0, draw: false };
    case '3': return { winnerGames: 2, loserGames: 1, draw: false };
    case '0': return { winnerGames: 1, loserGames: 1, draw: true };
    default: throw new Error(`invalid result code: ${code}`);
  }
}

// ---- record accumulation ----------------------------------------------------

// Build per-player records from the list of completed rounds (rounds with reported results).
// players: [{id, name, dropped}]
// rounds: [{number, tables: [{p1, p2|null, result: {winner, code} | {bye:true} | null}]}]
function buildRecords(players, rounds) {
  const rec = new Map();
  for (const p of players) {
    rec.set(p.id, {
      id: p.id, name: p.name, dropped: !!p.dropped,
      matchPoints: 0, gamePoints: 0, gamesPlayed: 0,
      matchesPlayed: 0, // excludes byes — used for MW% denominator alongside byes (see mwp)
      byes: 0, opponents: [],
    });
  }
  for (const round of rounds) {
    for (const t of round.tables) {
      if (t.p2 == null) { // bye
        const r = rec.get(t.p1);
        if (r) { r.matchPoints += MP_WIN; r.byes += 1; r.gamePoints += 2; r.gamesPlayed += 2; }
        continue;
      }
      if (!t.result) continue; // unreported — skip
      const a = rec.get(t.p1);
      const b = rec.get(t.p2);
      if (!a || !b) continue;
      a.opponents.push(b.id); b.opponents.push(a.id);
      a.matchesPlayed += 1; b.matchesPlayed += 1;
      const mr = matchRecord(t.result.code);
      if (mr.draw) {
        a.matchPoints += MP_DRAW; b.matchPoints += MP_DRAW;
        a.gamePoints += 1; b.gamePoints += 1;
        a.gamesPlayed += 2; b.gamesPlayed += 2;
      } else {
        const w = t.result.winner === a.id ? a : b;
        const l = w === a ? b : a;
        w.matchPoints += MP_WIN;
        w.gamePoints += mr.winnerGames; l.gamePoints += mr.loserGames;
        const games = mr.winnerGames + mr.loserGames;
        w.gamesPlayed += games; l.gamesPlayed += games;
      }
    }
  }
  return rec;
}

// Match-win % for a player: matchPoints / (3 * roundsWithAnOpponentOrBye), floored at 1/3.
function mwp(r) {
  const rounds = r.matchesPlayed + r.byes;
  if (rounds === 0) return FLOOR;
  return Math.max(FLOOR, r.matchPoints / (3 * rounds));
}
// Game-win % : gamePoints / (3 * gamesPlayed)? We store gamePoints as games won, so games won / gamesPlayed.
function gwp(r) {
  if (r.gamesPlayed === 0) return FLOOR;
  return Math.max(FLOOR, r.gamePoints / r.gamesPlayed);
}

// Standings: array sorted best-first, each with computed tiebreakers.
function standings(players, rounds) {
  const rec = buildRecords(players, rounds);
  const arr = [...rec.values()];
  // tiebreaker passes need every player's mwp/gwp first
  const mwpById = new Map(arr.map(r => [r.id, mwp(r)]));
  const gwpById = new Map(arr.map(r => [r.id, gwp(r)]));
  for (const r of arr) {
    const opps = r.opponents; // byes contribute no opponent
    r.mwp = mwpById.get(r.id);
    r.gwp = gwpById.get(r.id);
    r.omw = opps.length ? opps.reduce((s, id) => s + mwpById.get(id), 0) / opps.length : FLOOR;
    r.ogw = opps.length ? opps.reduce((s, id) => s + gwpById.get(id), 0) / opps.length : FLOOR;
  }
  arr.sort((x, y) =>
    y.matchPoints - x.matchPoints ||
    y.omw - x.omw ||
    y.gwp - x.gwp ||
    y.ogw - x.ogw ||
    0);
  return arr;
}

// ---- pairing ----------------------------------------------------------------

// Recommended number of Swiss rounds by player count (WotC guidelines).
function recommendedRounds(n) {
  if (n <= 2) return 1;
  if (n <= 4) return 2;
  if (n <= 8) return 3;
  if (n <= 16) return 4;
  if (n <= 32) return 5;
  if (n <= 64) return 6;
  if (n <= 128) return 7;
  return 8;
}

// Have these two ids already played? Built from prior rounds.
function playedSet(players, rounds) {
  const set = new Set();
  for (const round of rounds) {
    for (const t of round.tables) {
      if (t.p2 == null) continue;
      set.add(`${t.p1}|${t.p2}`);
      set.add(`${t.p2}|${t.p1}`);
    }
  }
  return set;
}

// Backtracking pairer: order is the standing-ordered list of active player ids.
// Tries to pair each player with the nearest-ranked legal (non-rematch) opponent,
// down-pairing only when forced. Returns array of [a,b] pairs or null if impossible.
function backtrackPair(order, played) {
  if (order.length === 0) return [];
  const [head, ...rest] = order;
  for (let i = 0; i < rest.length; i++) {
    const cand = rest[i];
    if (played.has(`${head}|${cand}`)) continue;
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    const sub = backtrackPair(remaining, played);
    if (sub !== null) return [[head, cand], ...sub];
  }
  return null;
}

// Choose the bye recipient when player count is odd: lowest standing without a prior bye.
function chooseBye(activeOrdered, rec) {
  for (let i = activeOrdered.length - 1; i >= 0; i--) {
    const id = activeOrdered[i];
    if ((rec.get(id)?.byes || 0) === 0) return id;
  }
  return activeOrdered[activeOrdered.length - 1]; // everyone has had a bye — give to lowest anyway
}

// Pair the next round.
// players: full roster; rounds: completed/paired prior rounds; roundNumber: the round to produce.
// rng: injectable for deterministic round-1 / tests.
// Returns { number, tables: [{table, p1, p2|null, result:null}] }.
function pairRound(players, rounds, roundNumber, rng = Math.random) {
  const active = players.filter(p => !p.dropped).map(p => p.id);
  const rec = buildRecords(players, rounds);

  let ordered;
  if (roundNumber === 1 || rounds.length === 0) {
    ordered = shuffle(active, rng); // round 1: random
  } else {
    const ranking = standings(players, rounds).filter(r => !r.dropped).map(r => r.id);
    ordered = ranking.filter(id => active.includes(id));
  }

  let byeId = null;
  if (ordered.length % 2 === 1) {
    byeId = chooseBye(ordered, rec);
    ordered = ordered.filter(id => id !== byeId);
  }

  const played = playedSet(players, rounds);
  let pairs = backtrackPair(ordered, played);
  if (pairs === null) {
    // No rematch-free pairing exists (small field, many rounds). Fall back: allow rematches,
    // pairing adjacent in standing order so it is still as fair as possible.
    pairs = [];
    for (let i = 0; i + 1 < ordered.length; i += 2) pairs.push([ordered[i], ordered[i + 1]]);
  }

  const tables = pairs.map(([p1, p2], idx) => ({ table: idx + 1, p1, p2, result: null }));
  if (byeId != null) tables.push({ table: tables.length + 1, p1: byeId, p2: null, result: null });
  return { number: roundNumber, tables };
}

module.exports = {
  buildRecords, standings, mwp, gwp,
  recommendedRounds, pairRound, playedSet, backtrackPair,
  MP_WIN, MP_DRAW, FLOOR,
};
