'use strict';
// Single-elimination bracket seeding. Standard MTG top-cut layout so that, by seed,
// 1 can only meet 2 in the final, etc. Supports Top 4 and Top 8.

// Seed-index pairings for the first bracket round (0-based seeds, best = 0).
const SEEDING = {
  4: [[0, 3], [1, 2]],
  8: [[0, 7], [3, 4], [1, 6], [2, 5]],
};

// seedIds: player ids ordered best-first (length must be 4 or 8). Returns the opening round.
function firstRound(seedIds) {
  const layout = SEEDING[seedIds.length];
  if (!layout) throw new Error(`unsupported cut size: ${seedIds.length}`);
  const tables = layout.map(([a, b], i) => ({
    table: i + 1, p1: seedIds[a], p2: seedIds[b], result: null, confirmed: false,
  }));
  return { number: 1, tables };
}

// Given the winners of a completed round (in table order), build the next round by
// pairing adjacent winners. Returns null when there is a single winner (champion decided).
function nextRound(winnersInOrder, roundNumber) {
  if (winnersInOrder.length <= 1) return null;
  const tables = [];
  for (let i = 0; i + 1 < winnersInOrder.length; i += 2) {
    tables.push({ table: tables.length + 1, p1: winnersInOrder[i], p2: winnersInOrder[i + 1], result: null, confirmed: false });
  }
  return { number: roundNumber, tables };
}

// Label for a bracket round given how many tables it has (for nice messaging).
function roundLabel(numTables) {
  switch (numTables) {
    case 4: return 'Quarterfinals';
    case 2: return 'Semifinals';
    case 1: return 'Finals';
    default: return 'Bracket round';
  }
}

module.exports = { SEEDING, firstRound, nextRound, roundLabel };
