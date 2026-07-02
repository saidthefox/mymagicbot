'use strict';
// Regression for the bracket-confirm bug: bracket round numbers restart at 1, colliding
// with Swiss round numbers. The confirm ctx built for the opponent of a reported result
// must carry the pairing's bracket flag, or locateTable resolves it against the SWISS
// round of the same number — confirming/nulling the wrong table and stalling the bracket.
process.env.MTG_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mtgbot-test-'));
const test = require('node:test');
const assert = require('node:assert');
const { locateTable, confirmCtx } = require('../index');

// A tournament mid-top-cut: Swiss round 1 is history (confirmed), bracket round 1 is live.
// Both are "round 1, table 1" — the collision at the heart of the bug.
function cutTournament() {
  return {
    id: 't1', players: [],
    rounds: [{ number: 1, tables: [{ table: 1, p1: 'a', p2: 'b', result: { winner: 'a', code: '2' }, confirmed: true }] }],
    bracket: { size: 4, rounds: [{ number: 1, tables: [{ table: 1, p1: 'a', p2: 'c', result: { winner: 'a', code: '2' }, confirmed: false }] }] },
  };
}

test('confirmCtx carries the bracket flag from the pairing ctx', () => {
  const pairing = { type: 'pairing', bracket: true, tournamentId: 't1', round: 1, table: 1, userId: 'a' };
  const ctx = confirmCtx(pairing, 'c');
  assert.strictEqual(ctx.type, 'confirm');
  assert.strictEqual(ctx.bracket, true);
  assert.strictEqual(ctx.round, 1);
  assert.strictEqual(ctx.table, 1);
  assert.strictEqual(ctx.userId, 'c');
});

test('confirmCtx of a Swiss pairing is not a bracket ctx', () => {
  const ctx = confirmCtx({ type: 'pairing', tournamentId: 't1', round: 1, table: 1, userId: 'a' }, 'b');
  assert.strictEqual(ctx.bracket, false);
});

test('a bracket confirm ctx locates the bracket table, not the colliding Swiss table', () => {
  const t = cutTournament();
  const ctx = confirmCtx({ type: 'pairing', bracket: true, tournamentId: 't1', round: 1, table: 1, userId: 'a' }, 'c');
  const { table } = locateTable(t, ctx);
  assert.strictEqual(table, t.bracket.rounds[0].tables[0]);
  assert.notStrictEqual(table, t.rounds[0].tables[0]);
});

test('the bug shape: a confirm ctx WITHOUT the flag resolves to the Swiss table', () => {
  // Documents why the flag is load-bearing — if confirmCtx ever stops setting it,
  // this shows exactly what goes wrong (the Swiss table would be mutated).
  const t = cutTournament();
  const { table } = locateTable(t, { type: 'confirm', tournamentId: 't1', round: 1, table: 1, userId: 'c' });
  assert.strictEqual(table, t.rounds[0].tables[0]);
});
