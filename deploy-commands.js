'use strict';
// Registers slash commands to the guild. Run: npm run deploy
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('start-tournament')
    .setDescription('Start a tournament in this channel and ping opted-in members to join')
    .addStringOption(o => o.setName('name').setDescription('Tournament name (default: channel + date)'))
    .addIntegerOption(o => o.setName('rounds').setDescription('Number of Swiss rounds (default: auto by headcount)'))
    .addStringOption(o => o.setName('cut').setDescription('Top cut after Swiss')
      .addChoices({ name: 'None', value: 'none' }, { name: 'Top 4', value: 'top4' }, { name: 'Top 8', value: 'top8' })),

  new SlashCommandBuilder()
    .setName('start-tournament-decklists')
    .setDescription('Start a decklist-required tournament; joiners are prompted to paste a list')
    .addStringOption(o => o.setName('name').setDescription('Tournament name'))
    .addIntegerOption(o => o.setName('rounds').setDescription('Number of Swiss rounds'))
    .addStringOption(o => o.setName('cut').setDescription('Top cut after Swiss')
      .addChoices({ name: 'None', value: 'none' }, { name: 'Top 4', value: 'top4' }, { name: 'Top 8', value: 'top8' })),

  new SlashCommandBuilder().setName('roster')
    .setDescription('Send the current headcount/player list to all participants for confirmation'),

  new SlashCommandBuilder().setName('pair')
    .setDescription('Pair the next round and notify participants in their private channels'),

  new SlashCommandBuilder().setName('re-pair')
    .setDescription('Re-pair the most recent round, or from a specific round number')
    .addIntegerOption(o => o.setName('round').setDescription('Round number to re-pair from (default: last)')),

  new SlashCommandBuilder().setName('standings')
    .setDescription('Send current standings to all participants'),

  new SlashCommandBuilder().setName('resubmit')
    .setDescription('Ask all participants in the current round to re-report their results'),

  new SlashCommandBuilder().setName('drop')
    .setDescription('Drop a player from the tournament')
    .addUserOption(o => o.setName('player').setDescription('Player to drop').setRequired(true)),

  new SlashCommandBuilder().setName('cut')
    .setDescription('Start the single-elimination top cut after Swiss (uses the cut size set at start)'),

  new SlashCommandBuilder().setName('end')
    .setDescription('End the tournament, post final standings, and archive it'),

  // ---- player profile (anyone) ----
  new SlashCommandBuilder().setName('set-name')
    .setDescription('Set the name used for you in tournaments and decklists (defaults to your Discord handle)')
    .addStringOption(o => o.setName('name').setDescription('Your name, exactly as you want it shown').setRequired(true)),

  // ---- stats & history (anyone) ----
  new SlashCommandBuilder().setName('stats')
    .setDescription('Show match/tournament stats')
    .addUserOption(o => o.setName('player').setDescription('Whose stats (default: you)')),

  new SlashCommandBuilder().setName('history')
    .setDescription('Show recent tournaments and their winners'),

  new SlashCommandBuilder().setName('leaderboard')
    .setDescription('Show the all-time leaderboard'),

  // ---- admin setup (Manage Server) ----
  new SlashCommandBuilder().setName('tc-stats-channel')
    .setDescription('[admin] Make THIS the Stats & History channel and post the perpetual message'),

  new SlashCommandBuilder().setName('tc-to-guide')
    .setDescription('[admin] Post/update the perpetual Tournament Organizer guide in THIS channel'),

  new SlashCommandBuilder().setName('tc-admin-guide')
    .setDescription('[admin] Post/update the perpetual admin setup guide in THIS channel'),

  new SlashCommandBuilder().setName('tc-set-to-role')
    .setDescription('[admin] Set the role that may run tournament-organizer commands')
    .addRoleOption(o => o.setName('role').setDescription('The Tournament Organizer role').setRequired(true)),

  new SlashCommandBuilder().setName('tc-register')
    .setDescription('[admin] Register THIS channel as a managed tournament channel (creates join/notify roles)')
    .addStringOption(o => o.setName('label').setDescription('Display name (default: channel name)'))
    .addBooleanOption(o => o.setName('private').setDescription('Lock the channel so only joined members can see it (default: false)')),

  new SlashCommandBuilder().setName('tc-unregister')
    .setDescription('[admin] Stop managing THIS channel (roles are left intact)'),

  new SlashCommandBuilder().setName('tc-readme')
    .setDescription('[admin] Post/update the read-me message with join/leave + pings buttons for all channels'),
].map(c => c.toJSON());

(async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands },
  );
  console.log(`Registered ${commands.length} commands to guild ${process.env.GUILD_ID}`);
})().catch(err => { console.error(err); process.exit(1); });
