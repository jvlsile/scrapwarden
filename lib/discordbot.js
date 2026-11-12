// Bot de Discord en los dos sentidos, sin dependencias externas (Gateway por WebSocket + API REST):
// - chat global del juego → canal de Discord, y mensajes de ese canal → chat del juego
// - comandos de barra para el staff: /estado, /jugadores, /kick, /ban, /say, /wipe
// - presencia del bot con los jugadores conectados
const WebSocket = require('ws');
const config = require('./config');
const rcon = require('./rcon');
const server = require('./server');
const audit = require('./audit');
const watch = require('./watch');
const wipes = require('./wipes');
const moderation = require('./moderation');
const vip = require('./vip');
const tickets = require('./tickets');
const { bus, log } = require('./bus');
const { E, L, tr } = require('./i18n');

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const GATEWAY = process.env.DISCORD_GATEWAY || 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
const PERM_KICK = '2'; // los comandos de staff solo aparecen a quien puede expulsar miembros en Discord

const DEFAULTS = {
  enabled: false,
  token: '',
  chatChannelId: '',
  relayToDiscord: true,
  relayToGame: true,
  commands: true,
  presence: true,
};

let ws = null, hbTimer = null, seq = null, reconnectTimer = null, presenceTimer = null;
let state = { status: 'off', user: null, appId: null, guildId: null, error: null, since: null };
let outQueue = [], flushing = false;

const settings = () => ({ ...DEFAULTS, ...(config.get().discordBot || {}) });
const lang = () => config.get().panel.notifyLang || 'es';
const T = (k, p) => tr(lang(), k, p);

// ---------- API REST (con reintento si Discord pide esperar) ----------
async function rest(method, path, body, tries = 2) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${settings().token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com, 1.0) Oxidian' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && tries > 0) {
    const j = await res.json().catch(() => ({}));
    await new Promise(r => setTimeout(r, Math.min(10000, (j.retry_after || 1) * 1000)));
    return rest(method, path, body, tries - 1);
  }
  if (!res.ok) { const txt = await res.text().catch(() => ''); const err = new Error(`Discord ${res.status}: ${txt.slice(0, 160)}`); err.status = res.status; throw err; }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Discord no debe poder mencionar a @everyone ni a nadie desde el chat del juego
const noPing = { parse: [] };
const clean = (s) => String(s || '').replace(/@(everyone|here)/g, '@​$1').replace(/<@[!&]?\d+>/g, '@?');

// Mensajes del juego agrupados para no chocar con los límites de Discord
function queueToDiscord(line) {
  const s = settings();
  if (state.status !== 'ready' || !s.relayToDiscord || !s.chatChannelId) return;
  outQueue.push(line);
  if (!flushing) { flushing = true; setTimeout(flush, 1200); }
}
async function flush() {
  const lines = outQueue.splice(0, 20);
  flushing = false;
  if (!lines.length) return;
  let content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1900) + '…';
  try { await rest('POST', `/channels/${settings().chatChannelId}/messages`, { content, allowed_mentions: noPing }); }
  catch (e) { state.error = e.message; }
  if (outQueue.length) { flushing = true; setTimeout(flush, 1200); }
}
const md = (s) => String(s).replace(/([\\*_`~|>])/g, '\\$1');

// ---------- Gateway ----------
function send(op, d) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d })); }

function connect() {
  const s = settings();
  clearTimeout(reconnectTimer);
  if (!s.enabled || !s.token) { setState('off'); return; }
  setState('connecting');
  try { ws = new WebSocket(GATEWAY); } catch (e) { setState('error', e.message); return schedule(); }
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.s != null) seq = m.s;
    if (m.op === 10) {
      clearInterval(hbTimer);
      hbTimer = setInterval(() => send(1, seq), m.d.heartbeat_interval);
      send(2, { token: s.token, intents: INTENTS, properties: { os: process.platform, browser: 'oxidian', device: 'oxidian' }, presence: presencePayload() });
    } else if (m.op === 7 || m.op === 9) {
      try { ws.close(4000); } catch {}
    } else if (m.op === 0) onDispatch(m.t, m.d).catch(e => { state.error = e.message; });
  });
  ws.on('close', (code) => {
    clearInterval(hbTimer);
    const fatal = { 4004: 'discord_bad_token', 4014: 'discord_intents', 4013: 'discord_intents' }[code];
    if (fatal) { setState('error', T('err.' + fatal)); log('panel', L('discord_bot_error', { error: { k: 'err.' + fatal } })); return; }
    if (settings().enabled) { setState('connecting'); schedule(); }
  });
  ws.on('error', (e) => { state.error = e.message; });
}
function schedule() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 8000); }
function setState(status, error = null) { state.status = status; if (error !== null) state.error = error; if (status === 'ready') { state.error = null; state.since = Date.now(); } }

async function onDispatch(t, d) {
  if (t === 'READY') {
    state.user = d.user ? `${d.user.username}` : null;
    state.appId = d.application?.id || d.user?.id || null;
    setState('ready');
    log('panel', L('discord_bot_ready', { name: state.user || '?' }));
    await setupCommands().catch(e => { state.error = e.message; });
    updatePresence();
  }
  if (t === 'MESSAGE_CREATE') await onMessage(d);
  if (t === 'INTERACTION_CREATE' && d.type === 2) await onCommand(d);
}

// ---------- Discord → juego ----------
async function onMessage(d) {
  const s = settings();
  if (!s.relayToGame || d.channel_id !== s.chatChannelId || d.author?.bot || d.webhook_id) return;
  let text = String(d.content || '').replace(/<a?:(\w+):\d+>/g, ':$1:').replace(/<[@#][!&]?\d+>/g, '').replace(/\s+/g, ' ').trim();
  if (!text || !rcon.isConnected()) return;
  if (moderation.matchWord && moderation.matchWord(text)) return; // mismo filtro de palabras que el chat del juego
  const name = String(d.member?.nick || d.author?.global_name || d.author?.username || '?').replace(/["\n]/g, '').slice(0, 24);
  text = text.slice(0, 200);
  await moderation.say(`[Discord] ${name}: ${text}`, 'Discord').catch(() => {});
}

// ---------- Juego → Discord ----------
function onGameChat(c) {
  if (!c || c.Channel === 1) return; // el chat de equipo es privado: no se publica
  const name = String(c.Username || '');
  const id = String(c.UserId || '');
  if (!/^\d{17}$/.test(id) || name === 'SERVER') return; // mensajes del propio servidor (avisos, Discord) no se reenvían
  queueToDiscord(`**${md(clean(name))}**: ${md(clean(c.Message))}`);
}

// ---------- Comandos de barra ----------
// Nombres traducidos: cada usuario de Discord ve los comandos en el idioma de su cliente
const LOC = {
  estado: { 'en-US': 'status', 'en-GB': 'status', 'pt-BR': 'status', fr: 'statut' },
  jugadores: { 'en-US': 'players', 'en-GB': 'players', 'pt-BR': 'jogadores', fr: 'joueurs' },
  jugador: { 'en-US': 'player', 'en-GB': 'player', 'pt-BR': 'jogador', fr: 'joueur' },
  motivo: { 'en-US': 'reason', 'en-GB': 'reason', 'pt-BR': 'motivo', fr: 'raison' },
  mensaje: { 'en-US': 'message', 'en-GB': 'message', 'pt-BR': 'mensagem', fr: 'message' },
  dias: { 'en-US': 'days', 'en-GB': 'days', 'pt-BR': 'dias', fr: 'jours' },
  grupo: { 'en-US': 'group', 'en-GB': 'group', 'pt-BR': 'grupo', fr: 'groupe' },
};
const localize = (c) => ({ ...c, ...(LOC[c.name] ? { name_localizations: LOC[c.name] } : {}), ...(c.options ? { options: c.options.map(localize) } : {}) });
const CMD = () => CMD_BASE().map(localize);
const CMD_BASE = () => [
  { name: 'estado', description: T('dc.cmd.status'), type: 1 },
  { name: 'jugadores', description: T('dc.cmd.players'), type: 1 },
  { name: 'wipe', description: T('dc.cmd.wipe'), type: 1 },
  { name: 'say', description: T('dc.cmd.say'), type: 1, default_member_permissions: PERM_KICK, options: [{ type: 3, name: 'mensaje', description: T('dc.opt.message'), required: true, max_length: 200 }] },
  { name: 'kick', description: T('dc.cmd.kick'), type: 1, default_member_permissions: PERM_KICK, options: [{ type: 3, name: 'jugador', description: T('dc.opt.player'), required: true }, { type: 3, name: 'motivo', description: T('dc.opt.reason'), required: false, max_length: 120 }] },
  { name: 'ban', description: T('dc.cmd.ban'), type: 1, default_member_permissions: PERM_KICK, options: [{ type: 3, name: 'jugador', description: T('dc.opt.player'), required: true }, { type: 3, name: 'motivo', description: T('dc.opt.reason'), required: false, max_length: 120 }] },
  { name: 'vip', description: T('dc.cmd.vip'), type: 1, default_member_permissions: PERM_KICK, options: [{ type: 3, name: 'jugador', description: T('dc.opt.player'), required: true }, { type: 4, name: 'dias', description: T('dc.opt.days'), required: true, min_value: 0, max_value: 3650 }, { type: 3, name: 'grupo', description: T('dc.opt.group'), required: false, max_length: 40 }] },
  { name: 'tickets', description: T('dc.cmd.tickets'), type: 1, default_member_permissions: PERM_KICK },
];

async function setupCommands() {
  const s = settings();
  if (!s.commands || !state.appId) return;
  // Comandos del servidor de Discord del canal de chat: aparecen al momento (los globales tardan hasta una hora)
  let guildId = null;
  if (s.chatChannelId) { const ch = await rest('GET', `/channels/${s.chatChannelId}`).catch(() => null); guildId = ch?.guild_id || null; }
  state.guildId = guildId;
  if (guildId) await rest('PUT', `/applications/${state.appId}/guilds/${guildId}/commands`, CMD());
  else await rest('PUT', `/applications/${state.appId}/commands`, CMD());
}

const reply = (d, content, ephemeral = false) => rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: String(content).slice(0, 1900), flags: ephemeral ? 64 : 0, allowed_mentions: noPing } });
const opt = (d, name) => (d.data.options || []).find(o => o.name === name)?.value;
const who = (d) => d.member?.user?.username || d.user?.username || '?';

async function findPlayer(q) {
  const list = await rcon.json('playerlist', 6000).catch(() => []);
  if (!Array.isArray(list)) return { list: [] };
  q = String(q || '').trim();
  if (/^\d{17}$/.test(q)) { const p = list.find(x => x.SteamID === q); return p ? { p } : { id: q }; }
  const lq = q.toLowerCase();
  const exact = list.filter(x => String(x.DisplayName).toLowerCase() === lq);
  const part = exact.length ? exact : list.filter(x => String(x.DisplayName).toLowerCase().includes(lq));
  return part.length === 1 ? { p: part[0] } : { many: part.slice(0, 10) };
}

async function onCommand(d) {
  const s = settings();
  const name = d.data?.name;
  if (!s.commands) return reply(d, T('dc.disabled'), true);
  if (!rcon.isConnected() && name !== 'wipe') return reply(d, T('dc.offline'), true);
  try {
    if (name === 'estado') {
      const info = await rcon.json('serverinfo', 6000).catch(() => null);
      const st = server.getStatus();
      const nw = wipes.next() || (wipes.view().forced[0] ? { at: wipes.view().forced[0] } : null);
      const lines = [
        `**${md(info?.Hostname || config.get().server.hostname)}**`,
        T('dc.status.players', { n: info?.Players ?? 0, max: info?.MaxPlayers ?? config.get().server.maxplayers, q: info?.Queued ?? 0 }),
        T('dc.status.fps', { fps: Math.round(info?.Framerate || 0), ents: (info?.EntityCount || 0).toLocaleString(lang()) }),
        st.startedAt ? T('dc.status.uptime', { t: `<t:${Math.floor(st.startedAt / 1000)}:R>` }) : '',
        nw ? T('dc.status.wipe', { t: `<t:${Math.floor(nw.at / 1000)}:F>`, r: `<t:${Math.floor(nw.at / 1000)}:R>` }) : '',
      ].filter(Boolean);
      return reply(d, lines.join('\n'));
    }
    if (name === 'jugadores') {
      const list = await rcon.json('playerlist', 6000).catch(() => []);
      if (!Array.isArray(list) || !list.length) return reply(d, T('dc.players.none'));
      const names = list.map(p => md(clean(p.DisplayName))).sort((a, b) => a.localeCompare(b));
      return reply(d, `${T('dc.players.title', { n: names.length })}\n${names.join(', ')}`);
    }
    if (name === 'wipe') {
      const nw = wipes.next() || (wipes.view().forced[0] ? { at: wipes.view().forced[0], forced: true } : null);
      return reply(d, nw ? T(nw.forced ? 'dc.wipe.forced' : 'dc.wipe.next', { t: `<t:${Math.floor(nw.at / 1000)}:F>`, r: `<t:${Math.floor(nw.at / 1000)}:R>` }) : T('dc.wipe.none'));
    }
    if (name === 'say') {
      const msg = String(opt(d, 'mensaje') || '').trim();
      await moderation.say(msg, `Discord: ${who(d)}`);
      audit.record({ user: `discord:${who(d)}`, action: 'discord_say', details: msg.slice(0, 120), ok: true });
      return reply(d, T('dc.said'), true);
    }
    if (name === 'tickets') {
      const items = tickets.list('active').items.slice(0, 10);
      if (!items.length) return reply(d, T('dc.tickets.none'), true);
      return reply(d, `${T('dc.tickets.title', { n: items.length })}\n` + items.map(t => `#${t.id} · **${md(clean(t.target.name))}** · ${T('dc.tickets.line', { n: t.reports, r: t.reporters })}${t.assignee ? ' · ' + md(t.assignee) : ''}`).join('\n'), true);
    }
    if (name === 'vip') {
      const r = await findPlayer(opt(d, 'jugador'));
      if (r.many) return reply(d, r.many.length ? T('dc.many', { list: r.many.map(p => md(p.DisplayName)).join(', ') }) : T('dc.notFound'), true);
      const id = r.p?.SteamID || r.id;
      const days = Number(opt(d, 'dias'));
      const group = String(opt(d, 'grupo') || vip.view().settings.defaultGroup);
      if (!vip.view().settings.groups.includes(group)) return reply(d, T('dc.vip.badGroup', { list: vip.view().settings.groups.join(', ') }), true);
      await vip.grant({ steamid: id, name: r.p?.DisplayName, group, days }, `discord:${who(d)}`);
      audit.record({ user: `discord:${who(d)}`, action: 'vip_grant', target: id, details: `${group} ${days}d`, ok: true });
      return reply(d, T(days === 0 ? 'dc.vip.granted_perm' : 'dc.vip.granted', { name: md(r.p?.DisplayName || id), group: md(group), n: days }));
    }
    if (name === 'kick' || name === 'ban') {
      const r = await findPlayer(opt(d, 'jugador'));
      if (r.many) return reply(d, r.many.length ? T('dc.many', { list: r.many.map(p => md(p.DisplayName)).join(', ') }) : T('dc.notFound'), true);
      const id = r.p?.SteamID || r.id;
      const pname = r.p?.DisplayName || id;
      const reason = String(opt(d, 'motivo') || T(name === 'ban' ? 'dc.defaultBan' : 'dc.defaultKick')).replace(/"/g, "'").slice(0, 120);
      if (name === 'kick') {
        if (!r.p) return reply(d, T('dc.notOnline'), true);
        await rcon.command(`kick ${id} "${reason}"`);
      } else {
        await rcon.command(`banid ${id} "${String(pname).replace(/"/g, "'")}" "${reason}"`);
        await rcon.command(`kick ${id} "${reason}"`).catch(() => {});
        await rcon.command('server.writecfg').catch(() => {});
        watch.markBanned(id, true);
      }
      audit.record({ user: `discord:${who(d)}`, action: name === 'ban' ? 'player_ban' : 'player_kick', target: id, details: reason, ok: true });
      log('panel', L(name === 'ban' ? 'discord_banned' : 'discord_kicked', { name: pname, by: who(d), reason }));
      return reply(d, T(name === 'ban' ? 'dc.banned' : 'dc.kicked', { name: md(pname), reason: md(reason) }));
    }
  } catch (e) {
    return reply(d, T('dc.error', { error: e.message }), true).catch(() => {});
  }
}

// ---------- Presencia ----------
let lastPresence = '';
function presencePayload(text) {
  return { since: null, afk: false, status: 'online', activities: text ? [{ name: text, type: 3 }] : [] };
}
async function updatePresence() {
  const s = settings();
  if (state.status !== 'ready' || !s.presence) return;
  let text = T('dc.presence.off');
  if (rcon.isConnected()) {
    const info = await rcon.json('serverinfo', 5000).catch(() => null);
    if (info) text = T('dc.presence.on', { n: info.Players | 0, max: info.MaxPlayers | 0 });
  }
  if (text === lastPresence) return;
  lastPresence = text;
  send(3, presencePayload(text));
}

// ---------- Panel ----------
function view() {
  const s = settings();
  const invite = state.appId ? `https://discord.com/oauth2/authorize?client_id=${state.appId}&scope=bot%20applications.commands&permissions=${(1 << 10) | (1 << 11) | (1 << 16)}` : null;
  return {
    settings: { ...s, token: undefined, hasToken: !!s.token, tokenHint: s.token ? '••••' + s.token.slice(-4) : '' },
    state: { ...state }, invite,
  };
}

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  for (const k of ['enabled', 'relayToDiscord', 'relayToGame', 'commands', 'presence']) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.chatChannelId !== undefined) {
    const c = String(input.chatChannelId || '').trim();
    if (c && !/^\d{15,22}$/.test(c)) throw E('discord_bad_channel');
    out.chatChannelId = c;
  }
  if (input.token !== undefined && String(input.token).trim()) {
    const tk = String(input.token).trim();
    if (!/^[\w.-]{50,100}$/.test(tk)) throw E('discord_bad_token_format');
    out.token = tk;
  }
  if (input.clearToken) out.token = '';
  config.update('discordBot', out);
  restart();
  return view();
}

function restart() {
  clearTimeout(reconnectTimer); clearInterval(hbTimer);
  if (ws) { try { ws.removeAllListeners('close'); ws.close(1000); } catch {} ws = null; }
  state = { status: 'off', user: null, appId: null, guildId: null, error: null, since: null };
  lastPresence = '';
  setTimeout(connect, 500);
}

function start() {
  bus.on('chat', onGameChat);
  connect();
  presenceTimer = setInterval(() => updatePresence().catch(() => {}), 60000);
  bus.on('rcon', () => setTimeout(() => updatePresence().catch(() => {}), 5000));
}

module.exports = { start, view, update };
