'use strict';
// Recent tournaments announced to MyMagicDeck, per guild — so /start-tournament can
// be launched from a previously announced one (autocomplete). Kept small (last 25).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MTG_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'announcements.json');

function loadAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function persist(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(all, null, 2)); }

function add(guildId, rec) {
  const all = loadAll();
  const list = all[guildId] || [];
  list.unshift({ ...rec, ts: Date.now() });
  all[guildId] = list.slice(0, 25);
  persist(all);
}
function recent(guildId) { return loadAll()[guildId] || []; }

module.exports = { add, recent };
