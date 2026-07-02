'use strict';
// JSON persistence for tournaments. One file per tournament under data/tournaments/,
// archived to data/archive/ on completion. Decklists under data/decklists/<tournamentId>/.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

const DATA_DIR = process.env.MTG_DATA_DIR || path.join(__dirname, '..', 'data');
const TOURN_DIR = path.join(DATA_DIR, 'tournaments');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const DECK_DIR = path.join(DATA_DIR, 'decklists');

for (const d of [DATA_DIR, TOURN_DIR, ARCHIVE_DIR, DECK_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

function tournPath(id) { return path.join(TOURN_DIR, `${id}.json`); }
function archivePath(id) { return path.join(ARCHIVE_DIR, `${id}.json`); }

// In-memory index of active (non-archived) tournaments: id -> tournament object.
// This is the authoritative copy in-process; disk is durability + restart recovery.
// It removes the per-call directory scan + JSON.parse that previously ran on every
// interaction, reaction, and message. Archived/discarded tournaments leave the cache.
const cache = new Map();
(function loadCache() {
  for (const f of fs.readdirSync(TOURN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TOURN_DIR, f), 'utf8'));
      cache.set(t.id, t);
    } catch { /* skip unreadable/partial files */ }
  }
})();

function newId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

// Tournament shape:
// { id, channelId, guildId, toId, name, status, requiresDecklists, cut,
//   plannedRounds, currentRound, createdAt,
//   players: [{id, name, dropped, decklist}],
//   rounds: [{number, tables:[{table,p1,p2|null,result|null, p1Reported, confirmed}]}] }

function create({ channelId, guildId, toId, name, requiresDecklists = false, cut = 'none' }) {
  const t = {
    id: newId(), channelId, guildId, toId, name,
    status: 'registration', requiresDecklists, cut,
    plannedRounds: null, currentRound: 0, createdAt: new Date().toISOString(),
    players: [], rounds: [],
  };
  save(t);
  return t;
}

function save(t) {
  cache.set(t.id, t);
  writeFileAtomic(tournPath(t.id), JSON.stringify(t, null, 2));
  return t;
}

function load(id) {
  return cache.get(id) || null;
}

function listActive() {
  return [...cache.values()];
}

// The single active (non-finished) tournament for a given tournament channel, if any.
function activeForChannel(channelId) {
  for (const t of cache.values()) {
    if (t.channelId === channelId && t.status !== 'finished') return t;
  }
  return null;
}

function archive(t) {
  t.status = 'finished';
  writeFileAtomic(archivePath(t.id), JSON.stringify(t, null, 2));
  try { fs.unlinkSync(tournPath(t.id)); } catch {}
  cache.delete(t.id);
  return t;
}

function listArchived() {
  return fs.readdirSync(ARCHIVE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')));
}

// Save a decklist exactly as pasted (raw), plus a parsed view if the [main]<side> format was used.
function saveDecklist(tournamentId, userId, raw) {
  const dir = path.join(DECK_DIR, tournamentId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, `${userId}.txt`), raw);
}

// Throw away an active tournament without archiving it (e.g. ended before any rounds).
function discard(id) {
  try { fs.unlinkSync(tournPath(id)); } catch {}
  cache.delete(id);
}

module.exports = {
  DATA_DIR, create, save, load, listActive, activeForChannel,
  archive, listArchived, saveDecklist, discard, newId,
};
