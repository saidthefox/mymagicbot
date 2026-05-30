'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// isolate data dir per run
process.env.MTG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtgstats-'));
const store = require('../lib/store');
const stats = require('../lib/stats');

function archiveTournament(name, players, rounds, bracket) {
  const t = store.create({ channelId: 'c', guildId: 'g', toId: 'to', name });
  t.players = players.map(([id, n]) => ({ id, name: n, dropped: false }));
  t.rounds = rounds;
  if (bracket) t.bracket = bracket;
  store.save(t);
  store.archive(t);
  return t;
}

test('aggregate counts wins, losses, draws, tournament wins', () => {
  archiveTournament('Wk1',
    [['a','Alice'],['b','Bob'],['c','Cara'],['d','Dan']],
    [
      { number: 1, tables: [
        { table: 1, p1: 'a', p2: 'b', result: { winner: 'a', code: '2' }, confirmed: true },
        { table: 2, p1: 'c', p2: 'd', result: { winner: 'c', code: '3' }, confirmed: true },
      ]},
      { number: 2, tables: [
        { table: 1, p1: 'a', p2: 'c', result: { winner: 'a', code: '2' }, confirmed: true },
        { table: 2, p1: 'b', p2: 'd', result: { winner: null, code: '0' }, confirmed: true },
      ]},
    ]);
  const alice = stats.playerStats('a');
  assert.strictEqual(alice.matchWins, 2);
  assert.strictEqual(alice.matchLosses, 0);
  assert.strictEqual(alice.tournaments, 1);
  assert.strictEqual(alice.tournamentWins, 1); // top of standings at 6 pts
  assert.strictEqual(stats.playerStats('b').matchDraws, 1);
  assert.strictEqual(stats.playerStats('d').matchLosses, 1);
});

test('bracket champion beats swiss leader for tournament win credit', () => {
  archiveTournament('Wk2',
    [['a','Alice'],['b','Bob'],['c','Cara'],['d','Dan']],
    [ { number: 1, tables: [
        { table: 1, p1: 'a', p2: 'b', result: { winner: 'a', code: '2' }, confirmed: true },
        { table: 2, p1: 'c', p2: 'd', result: { winner: 'c', code: '2' }, confirmed: true },
      ]} ],
    { size: 4, rounds: [ { number: 1, tables: [
        { table: 1, p1: 'a', p2: 'd', result: { winner: 'd', code: '3' }, confirmed: true },
        { table: 2, p1: 'b', p2: 'c', result: { winner: 'b', code: '2' }, confirmed: true },
      ]}, { number: 2, tables: [
        { table: 1, p1: 'd', p2: 'b', result: { winner: 'd', code: '2' }, confirmed: true },
      ]} ] });
  // Dan won the bracket even if not Swiss leader
  assert.strictEqual(stats.championId(store.listArchived().find(t => t.name === 'Wk2')), 'd');
});

test('leaderboard and recent tournaments populate', () => {
  const lb = stats.leaderboard();
  assert.ok(lb.length >= 1);
  const recent = stats.recentTournaments();
  assert.ok(recent.length >= 2);
  assert.ok(recent[0].winner);
});

test.after(() => { try { fs.rmSync(process.env.MTG_DATA_DIR, { recursive: true, force: true }); } catch {} });
