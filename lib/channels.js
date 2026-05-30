'use strict';
// Per-user private text channels: one p_<username> channel per participant, visible only to
// that user + the bot. Channels are created lazily and reused. Maps userId -> channelId are
// cached on disk so we don't recreate channels across restarts.
const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const DATA_DIR = process.env.MTG_DATA_DIR || path.join(__dirname, '..', 'data');
const MAP_FILE = path.join(DATA_DIR, 'private-channels.json');

function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; }
}
function saveMap(m) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2));
}

function sanitize(name) {
  return ('p-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/-+$/,'').slice(0, 95);
}

// Get (or create) the private channel for a guild member. Returns a TextChannel.
async function getPrivateChannel(guild, member) {
  const map = loadMap();
  const key = `${guild.id}:${member.id}`;
  if (map[key]) {
    const existing = guild.channels.cache.get(map[key]) || await guild.channels.fetch(map[key]).catch(() => null);
    if (existing) return existing;
  }
  const categoryId = process.env.PRIVATE_CATEGORY_ID || null;
  const channel = await guild.channels.create({
    name: sanitize(member.user.username),
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
  map[key] = channel.id;
  saveMap(map);
  return channel;
}

module.exports = { getPrivateChannel };
