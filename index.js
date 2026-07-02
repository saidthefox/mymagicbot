'use strict';
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const swiss = require('./lib/swiss');
const store = require('./lib/store');
const registry = require('./lib/registry');
const config = require('./lib/config');
const announce = require('./lib/announce');
const bracket = require('./lib/bracket');
const stats = require('./lib/stats');
const { getPrivateChannel } = require('./lib/channels');

const EMOJI = { up: '👍', down: '👎', draw: '0️⃣', win20: '2️⃣', win21: '3️⃣' };
const RESULT_EMOJI = { [EMOJI.draw]: '0', [EMOJI.win20]: '2', [EMOJI.win21]: '3' };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    // No MessageContent / GuildMessages: decklists come via the /decklist modal,
    // not by reading message text. Avoids the privileged Message Content intent
    // (and Discord verification) for a publicly-installable bot.
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// ---- helpers ----------------------------------------------------------------

function isAdmin(member) {
  return member && member.permissions.has(PermissionFlagsBits.ManageGuild);
}
// Authorized to run organizer commands on an existing tournament: the TO who started it,
// anyone holding the admin-assigned TO role, or a server admin.
function isTO(t, userId, member) {
  return t.toId === userId || canBeTO(t.guildId, member);
}
// Authorized to START a tournament: holds the configured TO role, or is a server admin.
function canBeTO(guildId, member) {
  if (!member) return false;
  if (isAdmin(member)) return true;
  const roleId = config.guild(guildId).toRoleId;
  return roleId ? member.roles.cache.has(roleId) : false;
}
function playerName(t, id) { return (t.players.find(p => p.id === id) || {}).name || id; }
function resultText(code) {
  return code === '0' ? 'a draw (1-1)' : code === '2' ? 'a 2-0 win' : 'a 2-1 win';
}

// Send a message to a participant's private channel; returns the Message (for reaction registration).
async function notify(guild, userId, content, reactWith = []) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  const ch = await getPrivateChannel(guild, member);
  const msg = await ch.send({ content: `<@${userId}> ${content}` });
  for (const e of reactWith) await msg.react(e).catch(() => {});
  return msg;
}

// Members opted in to pings for this channel. If the channel is registered with a notify role,
// that's the opt-in set. Otherwise fall back to anyone who can view the channel.
async function optedInMembers(channel) {
  await channel.guild.members.fetch();
  const cfg = config.channel(channel.guild.id, channel.id);
  if (cfg && cfg.notifyRoleId) {
    return channel.guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(cfg.notifyRoleId));
  }
  return channel.guild.members.cache.filter(m =>
    !m.user.bot && channel.permissionsFor(m).has(PermissionFlagsBits.ViewChannel));
}

function pairingInstructions(oppName) {
  return `Your match is against **${oppName}**.\n` +
    `When the match finishes, the **winner** reacts below: ${EMOJI.win20} = 2-0, ` +
    `${EMOJI.win21} = 2-1, ${EMOJI.draw} = draw. Your opponent then confirms.`;
}

// Locate a round/table from a reaction context, in either the Swiss rounds or the bracket.
function locateTable(t, ctx) {
  const rounds = ctx.bracket ? ((t.bracket && t.bracket.rounds) || []) : t.rounds;
  const round = rounds.find(r => r.number === ctx.round);
  const table = round && round.tables.find(tb => tb.table === ctx.table);
  return { round, table };
}

// The confirm-message context for the opponent of a reported result. Must carry the
// pairing's bracket flag: bracket round numbers restart at 1, so a confirm ctx without
// it resolves against the SWISS round of the same number and mutates the wrong table.
function confirmCtx(pairCtx, oppId) {
  return {
    type: 'confirm', bracket: !!pairCtx.bracket, tournamentId: pairCtx.tournamentId,
    round: pairCtx.round, table: pairCtx.table, userId: oppId,
  };
}

async function announceRound(guild, t, round, opts = {}) {
  const isBracket = !!opts.bracket;
  const header = isBracket
    ? `**${t.name} — ${opts.label || bracket.roundLabel(round.tables.length)}**`
    : `**${t.name} — Round ${round.number}, Table __T__**`;
  const elim = isBracket ? ' *(single elimination — no draws; play to a winner)*' : '';
  for (const table of round.tables) {
    if (table.p2 == null) {
      await notify(guild, table.p1,
        `**${t.name} — Round ${round.number}**: you have a **bye** this round (counts as a 2-0 win, 3 points). Sit tight for the next round.`);
      continue;
    }
    const reactSet = isBracket ? [EMOJI.win20, EMOJI.win21] : [EMOJI.win20, EMOJI.win21, EMOJI.draw];
    const head = isBracket ? `${header}, Table ${table.table}` : header.replace('__T__', table.table);
    const mmdNote = table.mmd ? '\n🟢 Or track + confirm this match in **MyMagicDeck 2040** — it reports back here automatically once you both confirm.' : '';
    const m1 = await notify(guild, table.p1, `${head}\n${pairingInstructions(playerName(t, table.p2))}${elim}${mmdNote}`, reactSet);
    if (m1) registry.set(m1.id, { type: 'pairing', bracket: isBracket, tournamentId: t.id, round: round.number, table: table.table, userId: table.p1 });
    const m2 = await notify(guild, table.p2, `${head}\n${pairingInstructions(playerName(t, table.p1))}${elim}${mmdNote}`, reactSet);
    if (m2) registry.set(m2.id, { type: 'pairing', bracket: isBracket, tournamentId: t.id, round: round.number, table: table.table, userId: table.p2 });
  }
}

function pairingSummary(t, round) {
  const lines = round.tables.map(tb =>
    tb.p2 == null ? `Bye — ${playerName(t, tb.p1)}`
      : `T${tb.table}: ${playerName(t, tb.p1)} vs ${playerName(t, tb.p2)}`);
  return `**${t.name} — Round ${round.number} pairings**\n` + lines.join('\n');
}

function standingsText(t) {
  const table = swiss.standings(t.players, t.rounds);
  const lines = table.map((r, i) =>
    `${i + 1}. **${r.name}** — ${r.matchPoints} pts ` +
    `(OMW ${(r.omw * 100).toFixed(1)}%, GW ${(r.gwp * 100).toFixed(1)}%, OGW ${(r.ogw * 100).toFixed(1)}%)` +
    (r.dropped ? ' *(dropped)*' : ''));
  return `**${t.name} — Standings after round ${t.currentRound}**\n` + lines.join('\n');
}

function allTablesConfirmed(round) {
  return round.tables.every(tb => tb.p2 == null || (tb.result && tb.confirmed));
}

async function promptTOAdvance(guild, t) {
  const last = t.rounds[t.rounds.length - 1];
  const done = t.currentRound >= (t.plannedRounds || swiss.recommendedRounds(t.players.filter(p => !p.dropped).length));
  const body = done
    ? `All round ${t.currentRound} results are in — that was the final Swiss round.\n` +
      (t.cut !== 'none'
        ? `Run **/cut** to start the **${t.cut}** single-elimination bracket, or **/standings** then **/end** to finish on Swiss.`
        : `Run **/standings** then **/end** to finish.`)
    : `All round ${t.currentRound} results are confirmed.\nReact ${EMOJI.up} to pair the next round, or ${EMOJI.down} to redo this round's results. (You can also type **/pair** or **/resubmit**.)`;
  const msg = await notify(guild, t.toId, body, done ? [] : [EMOJI.up, EMOJI.down]);
  if (msg && !done) registry.set(msg.id, { type: 'to-next', tournamentId: t.id, round: t.currentRound });
}

// Core pairing action shared by /pair and the TO 👍 reaction.
// ── MyMagicDeck 2040 integration: push a round's pairings so linked players can track + confirm there,
// and poll back the confirmed results to auto-fill the bracket. Both no-op if the integration isn't set. ──
const MMD_URL = () => (process.env.APP_API_URL || '');
const MMD_KEY = () => (process.env.MYMAGICDECK_BOT_KEY || '');
// On /end, tell MyMagicDeck the tournament concluded so the public ledger reveals decklists.
async function mmdConclude(t) {
  if (!MMD_URL() || !MMD_KEY() || !t || !t.id) return;
  try { await fetch(MMD_URL() + '/api/integrations/discord/tournament/' + encodeURIComponent(t.id) + '/conclude', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-key': MMD_KEY() }, body: '{}' }); } catch (_) {}
}
async function mmdPushPairings(t, round) {
  if (!MMD_URL() || !MMD_KEY()) return;
  const pairings = round.tables.filter(tb => tb.p2 != null).map(tb => ({ tmatch: round.number + ':' + tb.table, a_discord: tb.p1, b_discord: tb.p2 }));
  if (!pairings.length) return;
  try {
    const r = await fetch(MMD_URL() + '/api/integrations/discord/pairings', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-key': MMD_KEY() },
      body: JSON.stringify({ tourn: t.id, round: round.number, pairings }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(d.created)) {
      const set = new Set(d.created.map(c => c.tmatch));
      for (const tb of round.tables) if (set.has(round.number + ':' + tb.table)) tb.mmd = true;
      store.save(t);
    }
  } catch (e) { /* MMD is optional */ }
}
async function mmdPollResults() {
  if (!MMD_URL() || !MMD_KEY()) return;
  for (const t of store.listActive()) {
    if (!t.rounds || !t.rounds.length) continue;
    const last = t.rounds[t.rounds.length - 1];
    if (!last.tables.some(tb => tb.mmd && !(tb.result && tb.confirmed))) continue;
    let d;
    try {
      const r = await fetch(MMD_URL() + '/api/integrations/discord/pairings/' + encodeURIComponent(t.id) + '/results', { headers: { 'x-bot-key': MMD_KEY() } });
      d = await r.json().catch(() => null);
    } catch (e) { continue; }
    if (!d || !Array.isArray(d.results) || !d.results.length) continue;
    let changed = false;
    for (const res of d.results) {
      const [rnd, tbl] = String(res.tmatch || '').split(':');
      const rd = t.rounds.find(x => String(x.number) === rnd); if (!rd) continue;
      const tb = rd.tables.find(x => String(x.table) === tbl); if (!tb || (tb.result && tb.confirmed)) continue;
      tb.result = { winner: res.winner_discord || null, code: res.code }; tb.confirmed = true; tb.pendingConfirm = false; changed = true;
    }
    if (changed) {
      store.save(t);
      const guild = client.guilds.cache.get(t.guildId);
      if (guild && allTablesConfirmed(t.rounds[t.rounds.length - 1])) { try { await promptTOAdvance(guild, t); } catch (e) {} }
    }
  }
}
async function doPair(guild, t) {
  if (!t.plannedRounds) t.plannedRounds = swiss.recommendedRounds(t.players.filter(p => !p.dropped).length);
  t.status = 'playing';
  const round = swiss.pairRound(t.players, t.rounds, t.currentRound + 1);
  t.rounds.push(round);
  t.currentRound = round.number;
  store.save(t);
  await mmdPushPairings(t, round);   // mark 2040-tracked tables before announcing
  await announceRound(guild, t, round);
  return round;
}

function swissComplete(t) {
  const planned = t.plannedRounds || swiss.recommendedRounds(t.players.filter(p => !p.dropped).length);
  return t.currentRound >= planned && (!t.rounds.length || allTablesConfirmed(t.rounds[t.rounds.length - 1]));
}

// Begin the single-elimination top cut. Returns a status string for the TO.
async function startCut(guild, t) {
  const size = t.cut === 'top4' ? 4 : 8;
  const seeded = swiss.standings(t.players, t.rounds).filter(r => !r.dropped).slice(0, size).map(r => r.id);
  if (seeded.length < size) return `Need ${size} players for ${t.cut}, but only ${seeded.length} are eligible.`;
  t.bracket = { size, rounds: [] };
  t.phase = 'bracket';
  const round = bracket.firstRound(seeded);
  t.bracket.rounds.push(round);
  store.save(t);
  await announceRound(guild, t, round, { bracket: true });
  const lines = round.tables.map(tb => `T${tb.table}: ${playerName(t, tb.p1)} vs ${playerName(t, tb.p2)}`);
  return `**${t.name} — ${bracket.roundLabel(round.tables.length)}** (Top ${size})\n` + lines.join('\n');
}

async function advanceBracket(guild, t, completedRound) {
  const winners = completedRound.tables.map(tb => tb.result.winner);
  const next = bracket.nextRound(winners, completedRound.number + 1);
  if (next) {
    t.bracket.rounds.push(next);
    store.save(t);
    await announceRound(guild, t, next, { bracket: true });
    const lines = next.tables.map(tb => `T${tb.table}: ${playerName(t, tb.p1)} vs ${playerName(t, tb.p2)}`);
    await notify(guild, t.toId, `**${t.name} — ${bracket.roundLabel(next.tables.length)}**\n` + lines.join('\n'));
  } else {
    const champ = winners[0];
    t.phase = 'done';
    store.save(t);
    for (const p of t.players.filter(p => !p.dropped)) {
      await notify(guild, p.id, `🏆 **${playerName(t, champ)}** wins **${t.name}**! Thanks for playing.`);
    }
    await notify(guild, t.toId, `🏆 **${playerName(t, champ)}** is the champion. Run **/end** to post final results and archive.`);
  }
}

// ---- slash commands ---------------------------------------------------------

async function handleCommand(interaction) {
  const name = interaction.commandName;
  const channelId = interaction.channelId;
  const guild = interaction.guild;
  // Slow commands (API calls + per-player DM loops) can exceed Discord's 3s ack window → "application did
  // not respond". Defer up front, then route replies through editReply. (None of these open a modal.)
  const SLOW = new Set(['pair', 're-pair', 'roster', 'start-tournament', 'start-tournament-decklists', 'standings']);
  let _deferred = false;
  if (SLOW.has(name)) { try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); _deferred = true; } catch (_) {} }
  const reply = (content) => _deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: MessageFlags.Ephemeral });

  // ---- admin setup commands ----
  if (name === 'tc-set-to-role' || name === 'tc-register' || name === 'tc-unregister' || name === 'tc-readme' || name === 'tc-stats-channel' || name === 'tc-to-guide' || name === 'tc-admin-guide') {
    const m = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!isAdmin(m)) return reply('That command requires the **Manage Server** permission.');
    return handleAdminCommand(interaction, reply);
  }

  if (name === 'announce-tournament') {
    const m = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!canBeTO(guild.id, m)) {
      const roleId = config.guild(guild.id).toRoleId;
      return reply(roleId
        ? 'Only members with the Tournament Organizer role can announce tournaments.'
        : 'No Tournament Organizer role is set yet. An admin can set one with **/tc-set-to-role**.');
    }
    const payload = {
      title: interaction.options.getString('title'),
      date: interaction.options.getString('date'),
      format: interaction.options.getString('format') || 'Other',
      mode: interaction.options.getString('mode') || 'in-person',
      region: interaction.options.getString('region') || '',
      level: interaction.options.getString('level') || 'casual',
      entry_fee: interaction.options.getNumber('entry') || 0,
      url: interaction.options.getString('url') || '',
      source: guild.name,
    };
    try {
      const r = await fetch((process.env.APP_API_URL || '') + '/api/integrations/tournament', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-key': process.env.MYMAGICDECK_BOT_KEY || '' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        announce.add(guild.id, { appId: d.id, title: payload.title, date: payload.date, format: payload.format, mode: payload.mode, region: payload.region, level: payload.level });
        return reply(`📣 Announced **${payload.title}** (${payload.format}, ${payload.date}) to MyMagicDeck — notified ${d.notified ?? 0} subscriber(s). You can later run **/start-tournament** and pick it under *from*.`);
      }
      return reply(`Couldn't post to MyMagicDeck: ${d.error || ('HTTP ' + r.status)}`);
    } catch (e) { return reply('Could not reach MyMagicDeck (is APP_API_URL / the bot key set?).'); }
  }

  // ---- /link : bind this Discord account to a MyMagicDeck account via a one-time code ----
  if (name === 'link') {
    const code = (interaction.options.getString('code') || '').trim();
    if (!code) return reply('Get a code in MyMagicDeck → Account → 🔗 Link Discord, then run `/link <code>`.');
    try {
      const r = await fetch((process.env.APP_API_URL || '') + '/api/integrations/discord/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-key': process.env.MYMAGICDECK_BOT_KEY || '' },
        body: JSON.stringify({ code, discord_id: interaction.user.id, discord_name: interaction.user.username }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return reply(`✅ Linked your Discord to MyMagicDeck account **${d.username}**. Try **/mmd-stats**.`);
      return reply(`Couldn't link: ${d.error || ('HTTP ' + r.status)}`);
    } catch (e) { return reply('Could not reach MyMagicDeck (is APP_API_URL / the bot key set?).'); }
  }

  // ---- /mmd-stats : a linked player's MyMagicDeck 2040 record ----
  if (name === 'mmd-stats') {
    const target = interaction.options.getUser('player') || interaction.user;
    try {
      const r = await fetch((process.env.APP_API_URL || '') + '/api/integrations/discord/user/' + target.id, {
        headers: { 'x-bot-key': process.env.MYMAGICDECK_BOT_KEY || '' },
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const rec = d.record || { w: 0, l: 0, d: 0 };
        const score = `${rec.w}–${rec.l}${rec.d ? '–' + rec.d : ''}`;
        return reply(`🏆 **${d.username}** — 2040 record **${score}** (${d.winPct}% across ${d.matches} match${d.matches === 1 ? '' : 'es'}).`);
      }
      if (r.status === 404) {
        return reply(target.id === interaction.user.id
          ? 'You haven\'t linked a MyMagicDeck account yet — run **/link <code>** (get the code in MyMagicDeck → Account).'
          : `${target.username} hasn't linked a MyMagicDeck account.`);
      }
      return reply(`Couldn't fetch stats: ${d.error || ('HTTP ' + r.status)}`);
    } catch (e) { return reply('Could not reach MyMagicDeck.'); }
  }

  // ---- /decklist : open a modal to submit/update your decklist ----
  if (name === 'decklist') {
    const t = store.listActive().find(x => x.guildId === guild.id && x.requiresDecklists && x.players.some(p => p.id === interaction.user.id));
    if (!t) return reply("You're not registered for a decklist tournament here. Join one first (react 👍 to its post).");
    const modal = new ModalBuilder().setCustomId('decklist:' + t.id).setTitle(('Decklist — ' + t.name).slice(0, 45));
    const input = new TextInputBuilder().setCustomId('list').setLabel('Paste your decklist').setStyle(TextInputStyle.Paragraph)
      .setRequired(true).setMaxLength(4000).setPlaceholder('4 Lightning Bolt\n20 Mountain\n…\n\nSideboard\n3 Pyroblast');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (name === 'start-tournament' || name === 'start-tournament-decklists') {
    const starter = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!canBeTO(guild.id, starter)) {
      const roleId = config.guild(guild.id).toRoleId;
      return reply(roleId
        ? 'Only members with the Tournament Organizer role can start a tournament.'
        : 'No Tournament Organizer role is set yet. An admin can set one with **/tc-set-to-role**.');
    }
    if (store.activeForChannel(channelId)) return reply('There is already an active tournament in this channel. Use **/end** first.');
    const fromTitle = interaction.options.getString('from');
    const tName = fromTitle || interaction.options.getString('name') ||
      `${interaction.channel.name} — ${new Date().toISOString().slice(0, 10)}`;
    const rounds = interaction.options.getInteger('rounds');
    const cut = interaction.options.getString('cut') || 'none';
    const t = store.create({
      channelId, guildId: guild.id, toId: interaction.user.id, name: tName,
      requiresDecklists: name === 'start-tournament-decklists', cut,
    });
    if (fromTitle) { const a = announce.recent(guild.id).find(x => x.title === fromTitle); if (a && a.appId) { t.appTournamentId = a.appId; store.save(t); } }
    if (rounds) { t.plannedRounds = rounds; store.save(t); }
    const members = await optedInMembers(interaction.channel);
    let pinged = 0;
    for (const member of members.values()) {
      const extra = t.requiresDecklists
        ? ` This event **requires a decklist** — if you join, run \`/decklist\` to submit one (any format is saved as-is).`
        : '';
      const msg = await notify(guild, member.id,
        `A tournament is starting: **${t.name}**. React ${EMOJI.up} to join.${extra}`,
        [EMOJI.up]);
      if (msg) { registry.set(msg.id, { type: 'join', tournamentId: t.id, userId: member.id }); pinged++; }
    }
    return reply(`Started **${t.name}**${t.requiresDecklists ? ' (decklists required)' : ''}. Pinged ${pinged} members in their private channels. When players have joined, run **/roster**, then **/pair**.`);
  }

  // ---- player profile (anyone, anywhere) ----
  if (name === 'set-name') {
    const newName = interaction.options.getString('name').trim().slice(0, 80);
    if (!newName) return reply('Please give a non-empty name.');
    config.setName(guild.id, interaction.user.id, newName);
    let updated = 0;
    for (const at of store.listActive()) {
      const p = at.players.find(p => p.id === interaction.user.id);
      if (p) { p.name = newName; store.save(at); updated++; }
    }
    return reply(`Your tournament name is now **${newName}**. It's used on pairings, standings, and your decklists.` +
      (updated ? ` Updated in ${updated} active tournament(s).` : ''));
  }

  if (name === 'notifications') {
    const opt = interaction.options.getBoolean('enabled');
    if (opt === null) {
      const on = config.getNotify(guild.id, interaction.user.id);
      return reply(`Tournament reminders are currently **${on ? 'ON' : 'OFF'}** for you. Use \`/notifications enabled:true\` (or \`false\`) to change. When ON, I ping your private channel **2 weeks, 1 week, 3 days, and 1 day** before each upcoming tournament.`);
    }
    config.setNotify(guild.id, interaction.user.id, opt);
    return reply(opt
      ? "🔔 Tournament reminders **ON** — I'll ping your private channel 2 weeks, 1 week, 3 days, and 1 day before each upcoming tournament."
      : '🔕 Tournament reminders **OFF**. (Run `/notifications enabled:true` to turn them back on.)');
  }

  // ---- stats & history (anyone, anywhere) ----
  if (name === 'stats') {
    const target = interaction.options.getUser('player') || interaction.user;
    const s = stats.playerStats(target.id);
    if (!s) return reply(`No recorded matches yet for **${target.username}**.`);
    return reply(
      `**Stats — ${s.name}**\n` +
      `Tournaments: ${s.tournaments} (wins: ${s.tournamentWins})\n` +
      `Match record: ${s.matchWins}-${s.matchLosses}-${s.matchDraws} (${(s.winRate * 100).toFixed(1)}% match win)\n` +
      `Byes: ${s.byes}`);
  }
  if (name === 'history') {
    const recent = stats.recentTournaments(8);
    if (!recent.length) return reply('No completed tournaments yet.');
    const lines = recent.map(r => `• **${r.name}** (${r.date}) — winner **${r.winner}**, ${r.players} players`);
    return reply(`**Recent tournaments**\n${lines.join('\n')}`);
  }
  if (name === 'leaderboard') {
    const lb = stats.leaderboard(10);
    if (!lb.length) return reply('No data yet.');
    const lines = lb.map((r, i) => `${i + 1}. **${r.name}** — ${r.tournamentWins} 🏆, ${r.matchWins}-${r.matchLosses}-${r.matchDraws} (${(r.winRate * 100).toFixed(1)}%)`);
    return reply(`**Leaderboard**\n${lines.join('\n')}`);
  }

  // all remaining commands operate on the channel's active tournament
  const t = store.activeForChannel(channelId);
  if (!t) return reply('No active tournament in this channel. Start one with **/start-tournament**.');
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isTO(t, interaction.user.id, member)) return reply('Only the tournament organizer can run that.');

  if (name === 'roster') {
    const active = t.players.filter(p => !p.dropped);
    const list = active.map((p, i) => `${i + 1}. ${p.name}`).join('\n') || '(nobody yet)';
    for (const p of active) {
      await notify(guild, p.id, `**${t.name}** roster — ${active.length} players:\n${list}\nReact ${EMOJI.up} to confirm you're here.`, [EMOJI.up]);
    }
    return reply(`Roster sent to ${active.length} players.\n${list}`);
  }

  if (name === 'pair') {
    if (t.rounds.length && !allTablesConfirmed(t.rounds[t.rounds.length - 1]))
      return reply('The current round still has unconfirmed results. Use **/standings** to see, or **/resubmit** to redo.');
    if (t.players.filter(p => !p.dropped).length < 2) return reply('Need at least 2 players.');
    const round = await doPair(guild, t);
    return reply(pairingSummary(t, round));
  }

  if (name === 're-pair') {
    const from = interaction.options.getInteger('round') || t.currentRound;
    if (from < 1 || from > t.currentRound) return reply(`No round ${from} to re-pair (current round is ${t.currentRound}).`);
    t.rounds = t.rounds.slice(0, from - 1); // discard round `from` and later
    t.currentRound = from - 1;
    registry.clearTournament(t.id);
    store.save(t);
    const round = await doPair(guild, t);
    return reply(`Re-paired from round ${from}.\n${pairingSummary(t, round)}`);
  }

  if (name === 'standings') {
    const text = standingsText(t);
    for (const p of t.players.filter(p => !p.dropped)) await notify(guild, p.id, text);
    return reply(text);
  }

  if (name === 'resubmit') {
    const round = t.rounds[t.rounds.length - 1];
    if (!round) return reply('No round to resubmit.');
    for (const tb of round.tables) { tb.result = null; tb.confirmed = false; tb.pendingConfirm = false; }
    store.save(t);
    await announceRound(guild, t, round);
    return reply(`Asked all players to re-report round ${round.number} results.`);
  }

  if (name === 'drop') {
    const user = interaction.options.getUser('player');
    const p = t.players.find(x => x.id === user.id);
    if (!p) return reply('That player is not in the tournament.');
    p.dropped = true; store.save(t);
    await notify(guild, p.id, `You've been dropped from **${t.name}**. Thanks for playing!`);
    return reply(`Dropped ${p.name}.`);
  }

  if (name === 'cut') {
    if (t.cut === 'none') return reply('This tournament has no top cut. It was started with cut **none**.');
    if (t.bracket) return reply('The bracket has already started.');
    if (!swissComplete(t)) return reply('Finish all Swiss rounds (with confirmed results) before cutting to the bracket.');
    const status = await startCut(guild, t);
    return reply(status);
  }

  if (name === 'end') {
    if (t.players.length === 0 || t.rounds.length === 0) {
      registry.clearTournament(t.id);
      store.discard(t.id);
      return reply('No rounds were played, so this tournament was discarded — nothing archived.');
    }
    const text = standingsText(t);
    let champLine = '';
    if (t.bracket && t.bracket.rounds.length) {
      const champ = stats.championId(t);
      if (champ) champLine = `🏆 Champion: **${playerName(t, champ)}**\n`;
    }
    for (const p of t.players) await notify(guild, p.id, `**${t.name}** is complete!\n${champLine}${text}`);
    await interaction.channel.send(`🏆 **${t.name}** — final results\n${champLine}${text}`);
    await mmdConclude(t);   // reveal decklists in the public ledger
    registry.clearTournament(t.id);
    store.archive(t);
    await refreshStatsMessage(guild).catch(() => {});
    return reply('Tournament ended, final results posted, and archived.');
  }
}

// ---- reactions --------------------------------------------------------------

async function handleReaction(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => {});
  if (reaction.message.partial) await reaction.message.fetch().catch(() => {});
  const ctx = registry.get(reaction.message.id);
  if (!ctx) return;
  const t = store.load(ctx.tournamentId);
  if (!t) return;
  const guild = await client.guilds.fetch(t.guildId);
  const name = reaction.emoji.name;

  if (ctx.type === 'join' && name === EMOJI.up && user.id === ctx.userId) {
    if (t.status !== 'registration') { await notify(guild, user.id, `Sorry — **${t.name}** has already begun, you can't join now.`); return; }
    if (!t.players.find(p => p.id === user.id)) {
      const m = await guild.members.fetch(user.id).catch(() => null);
      const chosen = config.getName(guild.id, user.id) || (m ? m.displayName : user.username);
      t.players.push({ id: user.id, name: chosen, dropped: false, decklist: null });
      store.save(t);
      const ask = t.requiresDecklists ? ' Now run `/decklist` to submit your decklist.' : '';
      await notify(guild, user.id, `You're in for **${t.name}**! Wait for the organizer to pair round 1.${ask}`);
    }
    registry.remove(reaction.message.id);
    return;
  }

  if (ctx.type === 'pairing' && RESULT_EMOJI[name]) {
    const { table } = locateTable(t, ctx);
    if (!table || table.confirmed) return;
    const code = RESULT_EMOJI[name];
    if (ctx.bracket && code === '0') {
      await notify(guild, ctx.userId, `Draws aren't allowed in the bracket — play it out and report a winner (${EMOJI.win20} or ${EMOJI.win21}).`);
      return;
    }
    table.result = { winner: code === '0' ? null : ctx.userId, code };
    table.pendingConfirm = true;
    store.save(t);
    const oppId = table.p1 === ctx.userId ? table.p2 : table.p1;
    const reporter = playerName(t, ctx.userId);
    const desc = code === '0' ? 'a **draw**' : `**${reporter}** winning (${resultText(code)})`;
    const cmsg = await notify(guild, oppId,
      `${reporter} reported your match as ${desc}. React ${EMOJI.up} to confirm, or ${EMOJI.down} to dispute.`,
      [EMOJI.up, EMOJI.down]);
    if (cmsg) registry.set(cmsg.id, confirmCtx(ctx, oppId));
    return;
  }

  if (ctx.type === 'confirm' && user.id === ctx.userId) {
    const { round, table } = locateTable(t, ctx);
    if (!table) return;
    if (name === EMOJI.up) {
      table.confirmed = true; table.pendingConfirm = false; store.save(t);
      await notify(guild, table.p1, `Result confirmed. Hold tight for the next round pairings.`);
      await notify(guild, table.p2, `Result confirmed. Hold tight for the next round pairings.`);
      registry.remove(reaction.message.id);
      if (allTablesConfirmed(round)) {
        if (ctx.bracket) await advanceBracket(guild, t, round);
        else await promptTOAdvance(guild, t);
      }
    } else if (name === EMOJI.down) {
      table.result = null; table.pendingConfirm = false; store.save(t);
      registry.remove(reaction.message.id);
      await announceRound(guild, t, { number: ctx.round, tables: [table] }, { bracket: ctx.bracket });
      await notify(guild, table.p1, `Result disputed — please re-report this match.`);
    }
    return;
  }

  if (ctx.type === 'to-next') {
    const m = await guild.members.fetch(user.id).catch(() => null);
    if (!isTO(t, user.id, m)) return;
    registry.remove(reaction.message.id);
    if (name === EMOJI.up) {
      const round = await doPair(guild, t);
      await notify(guild, t.toId, pairingSummary(t, round));
    } else if (name === EMOJI.down) {
      const round = t.rounds[t.rounds.length - 1];
      for (const tb of round.tables) { tb.result = null; tb.confirmed = false; tb.pendingConfirm = false; }
      store.save(t);
      await announceRound(guild, t, round);
      await notify(guild, t.toId, `Asked all players to re-report round ${round.number}.`);
    }
    return;
  }
}

// ---- decklist intake (via the /decklist modal) ------------------------------

async function handleModal(interaction) {
  const [action, tid] = interaction.customId.split(':');
  if (action !== 'decklist') return;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const t = store.load(tid);
  if (!t || !t.requiresDecklists) return reply('That tournament is no longer accepting decklists.');
  const p = t.players.find(p => p.id === interaction.user.id);
  if (!p) return reply("You're not registered for that tournament.");
  const raw = interaction.fields.getTextInputValue('list') || '';
  if (raw.trim().length < 10) return reply('That decklist looks too short — please paste your full list.');
  store.saveDecklist(t.id, interaction.user.id, raw); // raw, exactly as pasted
  p.decklist = true; store.save(t);
  return reply(`Decklist saved for **${t.name}** — thanks! You're all set.`);
}

// ---- admin setup ------------------------------------------------------------

async function handleAdminCommand(interaction, reply) {
  const name = interaction.commandName;
  const guild = interaction.guild;

  if (name === 'tc-set-to-role') {
    const role = interaction.options.getRole('role');
    config.setToRole(guild.id, role.id);
    return reply(`Tournament Organizer role set to **${role.name}**. Members with this role can run **/start-tournament**. Assign it yourself in Server Settings — it's not self-serve.`);
  }

  if (name === 'tc-register') {
    const channel = interaction.channel;
    const label = interaction.options.getString('label') || channel.name;
    const makePrivate = interaction.options.getBoolean('private') || false;
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
      return reply('I need the **Manage Roles** permission to create the join/notify roles.');

    const existing = config.channel(guild.id, channel.id);
    const accessRole = existing?.accessRoleId
      ? await guild.roles.fetch(existing.accessRoleId).catch(() => null)
      : null;
    const access = accessRole || await guild.roles.create({ name: `${label} member`, mentionable: false });
    const notifyRole = existing?.notifyRoleId
      ? await guild.roles.fetch(existing.notifyRoleId).catch(() => null)
      : null;
    const notify = notifyRole || await guild.roles.create({ name: `${label} pings`, mentionable: false });

    if (makePrivate) {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      await channel.permissionOverwrites.edit(access, { ViewChannel: true });
    }
    config.registerChannel(guild.id, channel.id, { name: label, accessRoleId: access.id, notifyRoleId: notify.id });
    return reply(`Registered **${label}**.\n• Join role: **${access.name}**\n• Pings role: **${notify.name}**` +
      (makePrivate ? `\n• Locked the channel so only joined members can see it.` : '') +
      `\nRun **/tc-readme** in your info/read-me channel to post the buttons.`);
  }

  if (name === 'tc-unregister') {
    if (!config.channel(guild.id, interaction.channel.id)) return reply('This channel is not registered.');
    config.unregisterChannel(guild.id, interaction.channel.id);
    return reply('Unregistered this channel. The roles were left intact — delete them manually if you want them gone.');
  }

  if (name === 'tc-readme') {
    const channels = config.listChannels(guild.id);
    const entries = Object.entries(channels);
    if (!entries.length) return reply('No tournament channels registered yet. Run **/tc-register** in each one first.');
    const buttons = entries.map(([chId, c]) =>
      new ButtonBuilder().setCustomId(`tcping:${chId}`).setLabel(`🔔 ${c.name}`).setStyle(ButtonStyle.Secondary));
    const rows = [];
    for (let i = 0; i < buttons.length && rows.length < 5; i += 5) { // 5 buttons/row, 5 rows max
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    const content = [
      '🎴 **Welcome — how tournaments work here**',
      '',
      'The bot runs everything through **your own private channel**, so the public channels stay clean.',
      '',
      '**1. Turn on pings** for the tournaments you care about using the 🔔 buttons below. When an organizer starts one, you get a ping in your private channel.',
      '**2. Join** by reacting 👍 to that ping.',
      '**3. Play & report** — each round the bot DMs you your table. The **winner** reacts 2️⃣ (2-0), 3️⃣ (2-1), or 0️⃣ (draw); the other player confirms 👍. The bot tells you exactly what it needs at each step.',
      '',
      '**Set your name:** run `/set-name Your Name` — it’s what shows on pairings, standings, and your decklists (otherwise your Discord handle is used).',
      '**Decklist events:** when you join one, the bot asks you to paste your list in your private channel. Any format works — it’s saved exactly as pasted.',
      '',
      '📊 **Everything is tracked** in the **Stats & History** channel — past tournaments, winners, your decklists, and records. Anyone can run `/stats`, `/history`, and `/leaderboard` (replies are private to you).',
      '',
      '**Pick your pings below** — your choices are private; only you see the result of a click.',
    ].join('\n');
    // remove the bot's previous read-me post, if we still have it, so re-running doesn't pile up
    const prev = config.guild(guild.id);
    if (prev.readmeChannelId && prev.readmeMessageId) {
      const ch = await guild.channels.fetch(prev.readmeChannelId).catch(() => null);
      const old = ch && await ch.messages.fetch(prev.readmeMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
    const posted = await interaction.channel.send({ content, components: rows });
    config.setReadme(guild.id, interaction.channel.id, posted.id);
    if (entries.length > 25) await interaction.channel.send({ content: '*(More than 25 channels registered — only the first 25 fit on one message.)*' });
    return reply('Posted the read-me. It stays put; each click replies privately to that user.');
  }

  if (name === 'tc-stats-channel') {
    const msg = await interaction.channel.send({ content: statsMessageContent() });
    config.setStats(guild.id, interaction.channel.id, msg.id);
    return reply('This is now the Stats & History channel. The pinned message updates after each tournament; everyone can use **/stats**, **/history**, and **/leaderboard** (replies are private to each user).');
  }

  if (name === 'tc-to-guide') {
    const prev = config.guild(guild.id);
    if (prev.guideChannelId && prev.guideMessageId) {
      const ch = await guild.channels.fetch(prev.guideChannelId).catch(() => null);
      const old = ch && await ch.messages.fetch(prev.guideMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
    const posted = await interaction.channel.send({ content: toGuideContent() });
    config.setGuide(guild.id, interaction.channel.id, posted.id);
    return reply('Posted the Tournament Organizer guide. Re-run this command to refresh it (the old one is removed).');
  }

  if (name === 'tc-admin-guide') {
    const prev = config.guild(guild.id);
    if (prev.adminGuideChannelId && prev.adminGuideMessageId) {
      const ch = await guild.channels.fetch(prev.adminGuideChannelId).catch(() => null);
      const old = ch && await ch.messages.fetch(prev.adminGuideMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }
    const posted = await interaction.channel.send({ content: adminGuideContent() });
    config.setAdminGuide(guild.id, interaction.channel.id, posted.id);
    return reply('Posted the admin setup guide. Re-run this command to refresh it (the old one is removed).');
  }
}

// The perpetual admin setup guide (how to wire up tournament channels).
function adminGuideContent() {
  return [
    '🛠️ **Admin Setup Guide**',
    'These commands need the **Manage Server** permission. The bot needs **Manage Channels**, **Manage Roles** (with its own role dragged *above* the ones it creates), and the **Message Content** intent.',
    '',
    '**1. Name the organizers** — `/tc-set-to-role @Role`. Only people with this role (or admins) can start tournaments. Assign it by hand in Server Settings; it’s not self-serve.',
    '**2. Make each tournament channel** — create the channel (e.g. #wednesday-night), then run `/tc-register` *in it*. This creates its 🔔 ping role. Add `private: true` if you want the channel hidden until members join.',
    '   • `/tc-unregister` (in a channel) stops managing it.',
    '**3. Post the member read-me** — run `/tc-readme` in your read-me channel. Members get the how-it-works rundown + 🔔 ping toggles. Re-run to refresh (replaces the old one).',
    '**4. Set the stats channel** — run `/tc-stats-channel` in a #stats channel. Posts a perpetual message that auto-updates after each tournament; everyone can use `/stats`, `/history`, `/leaderboard`.',
    '**5. Post the TO guide** — run `/tc-to-guide` in your organizers-only channel for the full run-a-tournament reference.',
    '**6. This guide** — `/tc-admin-guide`. Re-run any of these to refresh in place.',
  ].join('\n');
}

// The perpetual Tournament Organizer guide (TO-only channel).
function toGuideContent() {
  return [
    '🗂️ **Tournament Organizer Guide**',
    'All commands reply **only to you** in the channel; players are messaged in their own private channels.',
    '',
    '**Run a tournament**',
    '1. `/start-tournament` — options: `name`, `rounds` (default auto by headcount), `cut` (none / top4 / top8). Pings everyone with that channel’s 🔔 ping role.',
    '   • Use `/start-tournament-decklists` instead to require decklists — joiners are asked to paste one.',
    '2. Players react 👍 in their private channel to join.',
    '3. `/roster` — sends the headcount/player list to everyone to confirm.',
    '4. `/pair` — pairs the next Swiss round and DMs each player their table + how to report.',
    '5. Results: the **winner** reacts 2️⃣ (2-0), 3️⃣ (2-1), or 0️⃣ (draw); the **loser** confirms 👍. Both get a "confirmed" note.',
    '6. When every match is confirmed you get a private prompt: 👍 to pair the next round, 👎 to redo results.',
    '7. After the final Swiss round: `/cut` to start the top4/top8 bracket (if set), or `/end` to finish on Swiss.',
    '',
    '**Anytime**',
    '• `/standings` — push current standings to all players.',
    '• `/re-pair` — redo the last round’s pairings. `/re-pair 3` rebuilds from round 3 onward.',
    '• `/resubmit` — ask everyone in the current round to re-report results.',
    '• `/drop @player` — drop a player.',
    '• `/end` — post final results, update stats, and archive the tournament.',
    '',
    '**Pairings follow sanctioned Swiss**: win 3 / draw 1 / loss 0, no rematches, byes (3 pts) to the lowest unbye’d player; standings break ties by OMW% → GW% → OGW%.',
  ].join('\n');
}

// The single perpetual message shown to everyone in the Stats & History channel.
function statsMessageContent() {
  const recent = stats.recentTournaments(3);
  const winners = recent.length
    ? recent.map(r => `• **${r.name}** (${r.date}) — 🏆 ${r.winner}`).join('\n')
    : '_No tournaments recorded yet._';
  return [
    '📊 **Stats & History**',
    '',
    '**Recent winners**',
    winners,
    '',
    '**Look things up** (responses are private to you):',
    '• `/stats` — your match & tournament record (or `/stats @player`)',
    '• `/history` — recent tournaments and their winners',
    '• `/leaderboard` — all-time standings',
  ].join('\n');
}

// Update the perpetual stats message in place after a tournament ends.
async function refreshStatsMessage(guild) {
  const cfg = config.guild(guild.id);
  if (!cfg.statsChannelId || !cfg.statsMessageId) return;
  const ch = await guild.channels.fetch(cfg.statsChannelId).catch(() => null);
  if (!ch) return;
  const msg = await ch.messages.fetch(cfg.statsMessageId).catch(() => null);
  if (msg) await msg.edit({ content: statsMessageContent() });
}

async function handleButton(interaction) {
  const [action, channelId] = interaction.customId.split(':');
  if (action !== 'tcjoin' && action !== 'tcping') return;
  const cfg = config.channel(interaction.guild.id, channelId);
  if (!cfg) return interaction.reply({ content: 'That channel is no longer managed.', flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const roleId = action === 'tcjoin' ? cfg.accessRoleId : cfg.notifyRoleId;
  const has = member.roles.cache.has(roleId);
  if (has) await member.roles.remove(roleId); else await member.roles.add(roleId);
  const labels = action === 'tcjoin'
    ? (has ? `left **${cfg.name}**` : `joined **${cfg.name}**`)
    : (has ? `turned **off** pings for **${cfg.name}**` : `turned **on** pings for **${cfg.name}**`);
  return interaction.reply({ content: `You ${labels}.`, flags: MessageFlags.Ephemeral });
}

// ---- wiring -----------------------------------------------------------------

// Tournament reminders: ping opted-in users (/notifications) in their private channel at fixed lead times
// before each upcoming Discord-sourced tournament. Dedup per (tournament,user,milestone) so each fires once.
const REMINDER_LEAD = { 14: 'in 2 weeks', 7: 'in 1 week', 3: 'in 3 days', 1: 'tomorrow' };
async function tournamentReminders() {
  if (!MMD_URL() || !MMD_KEY()) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const [, guild] of client.guilds.cache) {
    const users = config.notifyUsers(guild.id);
    if (!users.length) continue;
    for (const uid of users) {
      // Per-user: the server returns the server's own (Discord-sourced) events plus any community-listed
      // tournaments matching THIS user's subscription filters (via their linked MyMagicDeck account).
      let data;
      try {
        const r = await fetch(MMD_URL() + '/api/integrations/discord/tournaments/upcoming?days=15&discord=' + encodeURIComponent(uid), { headers: { 'x-bot-key': MMD_KEY() } });
        data = await r.json();
      } catch (_) { continue; }
      for (const t of (data && data.tournaments) || []) {
        const days = Math.round((new Date(t.date + 'T00:00:00') - today) / 86400000);
        const lead = REMINDER_LEAD[days];
        if (!lead) continue;
        const key = `${t.id}:${uid}:${days}`;
        if (config.reminderSent(guild.id, key)) continue;
        const line = `🔔 **${t.title}** (${t.format}) is ${lead} — ${t.date}${t.time ? ' ' + t.time : ''}${t.region ? ' · ' + t.region : ''}.${t.url ? ' ' + t.url : ''}`;
        const sent = await notify(guild, uid, line).catch(() => null);
        if (sent) config.markReminder(guild.id, key);
      }
    }
  }
}

// ---- wiring (reminders) -----------------------------------------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Poll MyMagicDeck for confirmed 2040 results and auto-fill the bracket (no-op if MMD isn't configured).
  if (MMD_URL() && MMD_KEY()) { setInterval(() => { mmdPollResults().catch(() => {}); }, 20000); }
  // Tournament reminders: check on boot, then every 6h (milestones are day-granular; dedup prevents repeats).
  if (MMD_URL() && MMD_KEY()) { tournamentReminders().catch(() => {}); setInterval(() => { tournamentReminders().catch(() => {}); }, 6 * 60 * 60 * 1000); }
});
async function handleAutocomplete(i) {
  if (i.commandName !== 'start-tournament' && i.commandName !== 'start-tournament-decklists') return i.respond([]);
  const q = (i.options.getFocused() || '').toLowerCase();
  const list = announce.recent(i.guildId)
    .filter(a => !q || (a.title || '').toLowerCase().includes(q))
    .slice(0, 25)
    .map(a => ({ name: `${a.title} (${a.format}, ${a.date})`.slice(0, 100), value: String(a.title).slice(0, 100) }));
  return i.respond(list);
}
client.on('interactionCreate', i => {
  if (i.isChatInputCommand()) {
    handleCommand(i).catch(err => {
      console.error(err); i.reply({ content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  } else if (i.isAutocomplete()) {
    handleAutocomplete(i).catch(err => { console.error('autocomplete', err); i.respond([]).catch(() => {}); });
  } else if (i.isButton()) {
    handleButton(i).catch(err => {
      console.error(err); i.reply({ content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  } else if (i.isModalSubmit()) {
    handleModal(i).catch(err => {
      console.error(err); i.reply({ content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  }
});
client.on('messageReactionAdd', (r, u) => handleReaction(r, u).catch(err => console.error('reaction', err)));

// Only log in when run directly (node index.js); tests require() this file for the helpers.
if (require.main === module) client.login(process.env.DISCORD_TOKEN);

module.exports = { locateTable, confirmCtx };
