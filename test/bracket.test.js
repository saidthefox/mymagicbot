'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bracket = require('../lib/bracket');

test('top 8 first round seeds 1v8, 4v5, 2v7, 3v6', () => {
  const seeds = ['s1','s2','s3','s4','s5','s6','s7','s8'];
  const r = bracket.firstRound(seeds);
  assert.deepStrictEqual(r.tables.map(t => [t.p1, t.p2]),
    [['s1','s8'],['s4','s5'],['s2','s7'],['s3','s6']]);
});

test('top 4 first round seeds 1v4, 2v3', () => {
  const r = bracket.firstRound(['s1','s2','s3','s4']);
  assert.deepStrictEqual(r.tables.map(t => [t.p1, t.p2]), [['s1','s4'],['s2','s3']]);
});

test('winners advance by pairing adjacent', () => {
  const r2 = bracket.nextRound(['w1','w2','w3','w4'], 2);
  assert.deepStrictEqual(r2.tables.map(t => [t.p1, t.p2]), [['w1','w2'],['w3','w4']]);
  const r3 = bracket.nextRound(['x1','x2'], 3);
  assert.deepStrictEqual(r3.tables.map(t => [t.p1, t.p2]), [['x1','x2']]);
  assert.strictEqual(bracket.nextRound(['champ'], 4), null);
});

test('unsupported cut size throws', () => {
  assert.throws(() => bracket.firstRound(['a','b','c','d','e','f']));
});

test('1-seed can only meet 2-seed in the final (top 8)', () => {
  // simulate higher seed always winning
  const seeds = ['s1','s2','s3','s4','s5','s6','s7','s8'];
  const rank = Object.fromEntries(seeds.map((s, i) => [s, i]));
  const winner = (a, b) => (rank[a] < rank[b] ? a : b);
  let round = bracket.firstRound(seeds);
  let n = 1;
  while (round) {
    const winners = round.tables.map(t => winner(t.p1, t.p2));
    if (winners.length === 1) { assert.strictEqual(winners[0], 's1'); break; }
    // before finals, s1 and s2 must not have met
    if (winners.length === 2) assert.deepStrictEqual(winners.sort(), ['s1','s2']);
    round = bracket.nextRound(winners, ++n);
  }
});
