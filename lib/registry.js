'use strict';
// Maps a Discord messageId -> an action context, so reaction handlers know what a reaction means.
// Persisted to disk so pending joins/results survive a bot restart.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

const DATA_DIR = process.env.MTG_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'reaction-registry.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function persist(m) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomic(FILE, JSON.stringify(m, null, 2)); }

// ctx examples:
//  { type:'join',    tournamentId, userId }
//  { type:'pairing', tournamentId, round, table, userId, bracket }   // userId = whose private channel
//  { type:'confirm', tournamentId, round, table, userId, bracket }   // userId = the opponent confirming
//  { type:'to-next', tournamentId, round }                           // TO advance/redo prompt
// `bracket` distinguishes top-cut tables from Swiss — round numbers collide between the two.
function set(messageId, ctx) { const m = load(); m[messageId] = ctx; persist(m); }
function get(messageId) { return load()[messageId] || null; }
function remove(messageId) { const m = load(); delete m[messageId]; persist(m); }

// Remove every entry for a tournament (e.g. on /re-pair or /end).
function clearTournament(tournamentId) {
  const m = load();
  for (const k of Object.keys(m)) if (m[k].tournamentId === tournamentId) delete m[k];
  persist(m);
}

module.exports = { set, get, remove, clearTournament };
