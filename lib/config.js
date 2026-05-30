'use strict';
// Per-guild configuration: the admin-assigned TO role, and the set of managed tournament
// channels (each with an "access" role for join/leave and a "notify" role for pings on/off).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MTG_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

function loadAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function persist(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(all, null, 2)); }

function guild(guildId) {
  const all = loadAll();
  return all[guildId] || { toRoleId: null, channels: {} };
}
function saveGuild(guildId, cfg) {
  const all = loadAll();
  all[guildId] = cfg;
  persist(all);
  return cfg;
}

function setToRole(guildId, roleId) {
  const cfg = guild(guildId); cfg.toRoleId = roleId; return saveGuild(guildId, cfg);
}
function registerChannel(guildId, channelId, data) {
  const cfg = guild(guildId); cfg.channels[channelId] = data; return saveGuild(guildId, cfg);
}
function unregisterChannel(guildId, channelId) {
  const cfg = guild(guildId); delete cfg.channels[channelId]; return saveGuild(guildId, cfg);
}
function channel(guildId, channelId) { return guild(guildId).channels[channelId] || null; }
function listChannels(guildId) { return guild(guildId).channels; }

function setStats(guildId, channelId, messageId) {
  const cfg = guild(guildId); cfg.statsChannelId = channelId; cfg.statsMessageId = messageId; return saveGuild(guildId, cfg);
}

// Player display names (used across pairings, standings, decklists). Defaults to Discord handle.
function setName(guildId, userId, name) {
  const cfg = guild(guildId); cfg.names = cfg.names || {}; cfg.names[userId] = name; return saveGuild(guildId, cfg);
}
function getName(guildId, userId) { return (guild(guildId).names || {})[userId] || null; }

function setReadme(guildId, channelId, messageId) {
  const cfg = guild(guildId); cfg.readmeChannelId = channelId; cfg.readmeMessageId = messageId; return saveGuild(guildId, cfg);
}
function setGuide(guildId, channelId, messageId) {
  const cfg = guild(guildId); cfg.guideChannelId = channelId; cfg.guideMessageId = messageId; return saveGuild(guildId, cfg);
}
function setAdminGuide(guildId, channelId, messageId) {
  const cfg = guild(guildId); cfg.adminGuideChannelId = channelId; cfg.adminGuideMessageId = messageId; return saveGuild(guildId, cfg);
}

module.exports = { guild, saveGuild, setToRole, registerChannel, unregisterChannel, channel, listChannels, setStats, setName, getName, setReadme, setGuide, setAdminGuide };
