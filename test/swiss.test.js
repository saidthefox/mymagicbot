'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/swiss');

// deterministic rng for reproducible round-1 shuffles
function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function mkPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, dropped: false }));
}

// Report every table in a round: lower-index player wins 2-0 unless overridden.
function autoReport(round, overrides = {}) {
  for (const t of round.tables) {
    if (t.p2 == null) continue;
    const key = `${t.p1}|${t.p2}`;
    const o = overrides[key];
    if (o) t.result = o;
    else t.result = { winner: t.p1, code: '2' };
  }
  return round;
}

test('round 1 pairs everyone, no byes for even field', () => {
  const players = mkPlayers(8);
  const r1 = S.pairRound(players, [], 1, seededRng(42));
  const paired = r1.tables.flatMap(t => [t.p1, t.p2]).filter(Boolean);
  assert.strictEqual(r1.tables.length, 4);
  assert.strictEqual(new Set(paired).size, 8);
  assert.ok(!r1.tables.some(t => t.p2 == null));
});

test('odd field gives exactly one bye', () => {
  const players = mkPlayers(7);
  const r1 = S.pairRound(players, [], 1, seededRng(7));
  const byes = r1.tables.filter(t => t.p2 == null);
  assert.strictEqual(byes.length, 1);
  const seated = r1.tables.flatMap(t => [t.p1, t.p2]).filter(Boolean);
  assert.strictEqual(new Set(seated).size, 7);
});

test('no rematches across a full Swiss event', () => {
  const players = mkPlayers(8);
  const rng = seededRng(123);
  const rounds = [];
  const numRounds = S.recommendedRounds(8); // 3
  for (let n = 1; n <= numRounds; n++) {
    const r = S.pairRound(players, rounds, n, rng);
    rounds.push(autoReport(r));
  }
  const seen = new Set();
  for (const round of rounds) {
    for (const t of round.tables) {
      if (t.p2 == null) continue;
      const key = [t.p1, t.p2].sort().join('|');
      assert.ok(!seen.has(key), `rematch detected: ${key}`);
      seen.add(key);
    }
  }
});

test('match points: win=3, draw=1, bye=3', () => {
  const players = mkPlayers(4);
  // p1 beats p2 (2-0), p3 draws p4
  const rounds = [{
    number: 1,
    tables: [
      { table: 1, p1: 'p1', p2: 'p2', result: { winner: 'p1', code: '2' } },
      { table: 2, p1: 'p3', p2: 'p4', result: { winner: null, code: '0' } },
    ],
  }];
  const rec = S.buildRecords(players, rounds);
  assert.strictEqual(rec.get('p1').matchPoints, 3);
  assert.strictEqual(rec.get('p2').matchPoints, 0);
  assert.strictEqual(rec.get('p3').matchPoints, 1);
  assert.strictEqual(rec.get('p4').matchPoints, 1);
});

test('bye awards 3 match points and is recorded', () => {
  const players = mkPlayers(3);
  const rounds = [{
    number: 1,
    tables: [
      { table: 1, p1: 'p1', p2: 'p2', result: { winner: 'p1', code: '3' } },
      { table: 2, p1: 'p3', p2: null, result: null },
    ],
  }];
  const rec = S.buildRecords(players, rounds);
  assert.strictEqual(rec.get('p3').matchPoints, 3);
  assert.strictEqual(rec.get('p3').byes, 1);
});

test('same player does not get two byes if avoidable', () => {
  const players = mkPlayers(5);
  const rng = seededRng(99);
  const rounds = [];
  for (let n = 1; n <= 3; n++) {
    const r = S.pairRound(players, rounds, n, rng);
    rounds.push(autoReport(r));
  }
  const byeCounts = {};
  for (const round of rounds) {
    for (const t of round.tables) {
      if (t.p2 == null) byeCounts[t.p1] = (byeCounts[t.p1] || 0) + 1;
    }
  }
  assert.ok(Object.values(byeCounts).every(c => c <= 1), `a player got >1 bye: ${JSON.stringify(byeCounts)}`);
});

test('standings sort by match points then OMW%', () => {
  const players = mkPlayers(4);
  const rounds = [
    { number: 1, tables: [
      { table: 1, p1: 'p1', p2: 'p2', result: { winner: 'p1', code: '2' } },
      { table: 2, p1: 'p3', p2: 'p4', result: { winner: 'p3', code: '2' } },
    ]},
    { number: 2, tables: [
      { table: 1, p1: 'p1', p2: 'p3', result: { winner: 'p1', code: '2' } },
      { table: 2, p1: 'p2', p2: 'p4', result: { winner: 'p2', code: '2' } },
    ]},
  ];
  const table = S.standings(players, rounds);
  assert.strictEqual(table[0].id, 'p1'); // 6 pts, top
  assert.strictEqual(table[0].matchPoints, 6);
  // p2 and p3 both have 3 pts; p3 beat p4 & lost to p1, p2 lost to p1 & beat p4 — ordered by OMW%
  const three = table.filter(r => r.matchPoints === 3).map(r => r.id);
  assert.deepStrictEqual(three.sort(), ['p2', 'p3']);
});

test('re-pair: rebuilding from round N uses only prior rounds', () => {
  const players = mkPlayers(8);
  const rng = seededRng(5);
  const rounds = [];
  for (let n = 1; n <= 3; n++) rounds.push(autoReport(S.pairRound(players, rounds, n, rng)));
  // simulate /re-pair 2: discard rounds >= 2, re-pair round 2 from round-1 state
  const kept = rounds.slice(0, 1);
  const re = S.pairRound(players, kept, 2, seededRng(5));
  // round 2 must avoid round-1 opponents
  const r1pairs = new Set();
  for (const t of kept[0].tables) if (t.p2) r1pairs.add([t.p1, t.p2].sort().join('|'));
  for (const t of re.tables) {
    if (!t.p2) continue;
    assert.ok(!r1pairs.has([t.p1, t.p2].sort().join('|')), 're-pair created a rematch');
  }
});
