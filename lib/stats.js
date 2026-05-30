'use strict';
// Aggregate stats computed from archived tournaments (data/archive/). Pure-ish: reads via store.
const store = require('./store');
const swiss = require('./swiss');

// Every round of a tournament (Swiss rounds + any elimination bracket rounds).
function allRounds(t) {
  return [...(t.rounds || []), ...((t.bracket && t.bracket.rounds) || [])];
}

// The champion of a finished tournament: bracket final winner if a bracket was played,
// otherwise the top of final Swiss standings.
function championId(t) {
  if (t.bracket && t.bracket.rounds && t.bracket.rounds.length) {
    const finals = t.bracket.rounds[t.bracket.rounds.length - 1];
    const decided = finals.tables.find(tb => tb.result && tb.confirmed && tb.result.winner);
    if (decided) return decided.result.winner;
  }
  const s = swiss.standings(t.players, t.rounds);
  return s.length ? s[0].id : null;
}

// Per-player match tally within one tournament.
function tallyTournament(t, acc) {
  for (const round of allRounds(t)) {
    for (const tb of round.tables) {
      if (tb.p2 == null) { // bye
        const a = acc(tb.p1); a.byes++; a.matchWins++;
        continue;
      }
      if (!tb.result) continue;
      const a = acc(tb.p1), b = acc(tb.p2);
      if (tb.result.code === '0') { a.matchDraws++; b.matchDraws++; }
      else {
        const w = tb.result.winner;
        if (w === tb.p1) { a.matchWins++; b.matchLosses++; }
        else { b.matchWins++; a.matchLosses++; }
      }
    }
  }
}

function blank(id, name) {
  return { id, name, tournaments: 0, tournamentWins: 0, matchWins: 0, matchLosses: 0, matchDraws: 0, byes: 0 };
}

// Aggregate every archived tournament into per-player records.
function aggregate() {
  const players = new Map();
  const get = id => { if (!players.has(id)) players.set(id, blank(id, id)); return players.get(id); };
  for (const t of store.listArchived()) {
    const seen = new Set();
    for (const p of t.players) { get(p.id).name = p.name; seen.add(p.id); get(p.id).tournaments++; }
    tallyTournament(t, get);
    const champ = championId(t);
    if (champ) get(champ).tournamentWins++;
  }
  return players;
}

function winRate(r) {
  const g = r.matchWins + r.matchLosses + r.matchDraws;
  return g ? r.matchWins / g : 0;
}

function playerStats(userId) {
  const r = aggregate().get(userId);
  return r ? { ...r, winRate: winRate(r) } : null;
}

function leaderboard(limit = 10) {
  return [...aggregate().values()]
    .filter(r => r.tournaments > 0)
    .sort((a, b) => b.tournamentWins - a.tournamentWins || winRate(b) - winRate(a) || b.matchWins - a.matchWins)
    .slice(0, limit)
    .map(r => ({ ...r, winRate: winRate(r) }));
}

// Recent tournaments, newest first.
function recentTournaments(limit = 5) {
  return store.listArchived()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit)
    .map(t => {
      const champ = championId(t);
      const champName = (t.players.find(p => p.id === champ) || {}).name || '—';
      return { id: t.id, name: t.name, date: (t.createdAt || '').slice(0, 10), players: t.players.length, winner: champName, winnerId: champ };
    });
}

module.exports = { aggregate, playerStats, leaderboard, recentTournaments, championId, winRate, allRounds };
