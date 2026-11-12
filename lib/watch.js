// Vigilancia: analiza eventos del complemento ScrapwardenBridge, el registro del servidor y la lista de
// jugadores para generar alertas de posibles trampas o comportamientos extraños.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const rcon = require('./rcon');
const plugins = require('./plugins');
const steam = require('./steam');
const ipcheck = require('./ipcheck');
const files = require('./files');
const { bus, log } = require('./bus');
const { E, L, tr, errParam } = require('./i18n');

const ALERTS_FILE = path.join(config.DATA_DIR, 'alerts.json');
const PLAYERS_FILE = path.join(config.DATA_DIR, 'players.json');
const BRIDGE_SRC = path.join(__dirname, 'bridge', 'ScrapwardenBridge.cs');
const MAX_ALERTS = 1000;

const DEFAULTS = {
  enabled: true,
  headshotRatio: 0.6,       // proporción de disparos a la cabeza que se considera sospechosa
  minHits: 25,              // impactos PvP mínimos antes de evaluar la proporción
  longShot: 350,            // metros para armas de largo alcance
  shortWeaponShot: 150,     // metros para pistolas, subfusiles, escopetas y arcos
  killsPer10Min: 15,
  violationsBurst: 5,       // infracciones de antihack en 10 min para avisar
  reportsForHigh: 3,        // reportes F7 de jugadores distintos en 1 h
  teamLimit: 0,             // tamaño máximo de equipo (0 = sin límite)
  cupboardGroups: true,     // detectar grupos que comparten armarios por encima del límite
  sharedIp: true,
  discordWebhook: '',
  discordMinSeverity: 'medium',
};
const SEV_RANK = { low: 1, medium: 2, high: 3 };
const SHORT_RANGE = /^(pistol\.|smg\.|shotgun\.|bow\.|crossbow)/;

let alerts = [];
let players = {};          // steamid -> { names[], ips[], firstSeen, lastSeen, banned, stats }
const live = new Map();    // steamid -> estadísticas en memoria (ventanas deslizantes)
const seenEvents = new Set();
const cooldowns = new Map();
let saveTimer = null;
let bridgeLoaded = false;

// ---------- Persistencia ----------
// Reconstruye los tiempos de espera a partir de las alertas guardadas para no repetirlas tras reiniciar el panel
function seedCooldowns() {
  const since = Date.now() - 24 * 3600000;
  for (const a of alerts) {
    if (a.t < since || !a.code) continue;
    const id = a.steamid, p = a.params || {}, ev = a.evidence || {};
    const key = {
      aim: `hs:${id}`, distance: `long:${id}`, distance_head: `long:${id}`, kills: `kills:${id}`,
      antihack: `vio:${id}`, antihack_high: `vio-high:${id}`, report_many: `rep-high:${id}`,
      shared_ip: p.otherId && `shared:${[id, p.otherId].sort().join(':')}`, evasion: p.otherId && `evade:${id}:${p.otherId}`,
      team_size: ev.id && `team:${ev.id}:${p.n}`, team_group: Array.isArray(ev.members) && 'group:' + [...ev.members].sort().join(','),
    }[a.code] || (a.code.startsWith('steam_') && `${a.code}:${id}`);
    if (key && !(cooldowns.get(key) > a.t)) cooldowns.set(key, a.t);
  }
}

function load() {
  try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { alerts = []; }
  seedCooldowns();
  try { players = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8')); } catch { players = {}; }
  if (!config.get().watch) config.update('watch', DEFAULTS);
  else config.update('watch', { ...DEFAULTS, ...config.get().watch });
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts));
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players));
  }, 2000);
}
const settings = () => config.get().watch;

// ---------- Registro de jugadores ----------
function playerRec(steamid, name) {
  if (!players[steamid]) players[steamid] = { names: [], ips: [], firstSeen: Date.now(), lastSeen: Date.now(), banned: false, totals: { violations: 0, reports: 0, hits: 0, headshots: 0, kills: 0, longest: 0 } };
  const p = players[steamid];
  if (name && !p.names.includes(name)) { p.names.push(name); if (p.names.length > 10) p.names.shift(); }
  return p;
}
function liveRec(steamid) {
  if (!live.has(steamid)) live.set(steamid, { hits: [], kills: [], violations: [], reports: [] });
  return live.get(steamid);
}
const displayName = (id) => players[id]?.names.at(-1) || id;

// ---------- Alertas ----------
function onCooldown(key, minutes) {
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < minutes * 60000) return true;
  cooldowns.set(key, Date.now());
  return false;
}

// code: clave de la alerta (alert.<code>.title / alert.<code>.detail), params: valores para el texto
function addAlert({ severity, kind, code, params = {}, steamid = null, name = null, evidence = null }) {
  const a = {
    id: crypto.randomBytes(6).toString('hex'), t: Date.now(), severity, kind, code, params,
    steamid, name: name || (steamid ? displayName(steamid) : null), evidence, status: 'new',
  };
  alerts.unshift(a);
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  scheduleSave();
  log('watch', L('alert', { sev: { k: 'sev.' + severity }, title: { k: `alert.${code}.title`, p: params }, name: a.name || '—' }));
  bus.emit('alert', a);
  notifyDiscord(a);
  return a;
}

function listAlerts({ status, severity, steamid, limit = 200 } = {}) {
  return alerts.filter(a =>
    (!status || status === 'all' || a.status === status) &&
    (!severity || severity === 'all' || a.severity === severity) &&
    (!steamid || a.steamid === steamid)).slice(0, limit);
}
function setStatus(id, status) {
  const a = alerts.find(x => x.id === id);
  if (!a) throw E('alert_not_found');
  a.status = status; scheduleSave(); return a;
}
function markAll() { alerts.forEach(a => { if (a.status === 'new') a.status = 'reviewed'; }); scheduleSave(); }
function clearReviewed() { alerts = alerts.filter(a => a.status === 'new'); scheduleSave(); }
const unread = () => alerts.filter(a => a.status === 'new').length;

// ---------- Discord ----------
const discordQueue = [];
let discordBusy = false;
function notifyDiscord(a) {
  const s = settings();
  if (!s.discordWebhook || SEV_RANK[a.severity] < SEV_RANK[s.discordMinSeverity || 'medium']) return;
  discordQueue.push(a);
  pumpDiscord();
}
async function pumpDiscord() {
  if (discordBusy || !discordQueue.length) return;
  discordBusy = true;
  const a = discordQueue.shift();
  try { await sendDiscord(a); } catch (e) { log('panel', L('discord_error', { error: errParam(e) })); }
  setTimeout(() => { discordBusy = false; pumpDiscord(); }, 1200);
}
async function sendDiscord(a, webhook = settings().discordWebhook) {
  if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(webhook)) throw E('bad_webhook');
  const colors = { high: 0xD0682F, medium: 0xE0A93B, low: 0x7E8A95 };
  const lang = config.get().panel.notifyLang || 'es';
  const fields = [];
  if (a.steamid) fields.push({ name: tr(lang, 'discord.player'), value: `${a.name || '—'}\n[${a.steamid}](https://steamcommunity.com/profiles/${a.steamid})`, inline: true });
  fields.push({ name: tr(lang, 'discord.severity'), value: tr(lang, 'sev.' + a.severity), inline: true });
  const res = await fetch(webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Scrapwarden',
      embeds: [{ title: tr(lang, `alert.${a.code}.title`, a.params), description: tr(lang, `alert.${a.code}.detail`, a.params), color: colors[a.severity], fields, timestamp: new Date(a.t).toISOString(), footer: { text: config.get().server.hostname } }],
    }),
  });
  if (!res.ok) throw E('discord_status', { status: res.status });
}

// ---------- Eventos del complemento ----------
const prune = (arr, ms) => { const lim = Date.now() - ms; while (arr.length && arr[0].t < lim) arr.shift(); };

function handleBridgeEvent(ev) {
  if (!ev || !ev.type || !settings().enabled) return;
  if (ev.id) {
    if (seenEvents.has(ev.id)) return;
    seenEvents.add(ev.id);
    if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value);
  }
  if (!bridgeError) bridgeLoaded = true;
  const s = settings();
  const id = String(ev.steamid || '');
  if (!/^\d{17}$/.test(id)) return;
  const rec = playerRec(id, ev.name);
  const lv = liveRec(id);
  const t = Date.now();

  if (ev.type === 'connect') {
    const ip = String(ev.ip || '').replace(/:\d+$/, '');
    if (ip && !rec.ips.includes(ip)) { rec.ips.push(ip); if (rec.ips.length > 10) rec.ips.shift(); }
    queueSteam(id, ev.name);
    if (ip) queueIp(id, ev.name, ip);
    checkBanlist(id, ev.name);
  }

  if (ev.type === 'violation') {
    rec.totals.violations++;
    lv.violations.push({ t, kind: ev.kind, amount: ev.amount });
    prune(lv.violations, 10 * 60000);
    const n = lv.violations.length;
    const kinds = [...new Set(lv.violations.map(v => v.kind))].join(', ');
    if (n >= s.violationsBurst * 3 && !onCooldown(`vio-high:${id}`, 15)) {
      addAlert({ severity: 'high', kind: 'antihack', code: 'antihack_high', params: { n, kinds, pos: ev.pos }, steamid: id, name: ev.name, evidence: lv.violations.slice(-10) });
    } else if (n >= s.violationsBurst && !onCooldown(`vio:${id}`, 10)) {
      addAlert({ severity: 'medium', kind: 'antihack', code: 'antihack', params: { n, kinds }, steamid: id, name: ev.name, evidence: lv.violations.slice(-10) });
    }
  }

  if (ev.type === 'report') {
    rec.totals.reports++;
    lv.reports.push({ t, reporter: ev.reporter, subject: ev.subject });
    prune(lv.reports, 60 * 60000);
    const reporters = new Set(lv.reports.map(r => r.reporter)).size;
    const text = [ev.subject, ev.message].filter(Boolean).join(': ');
    if (reporters >= s.reportsForHigh && !onCooldown(`rep-high:${id}`, 30)) {
      addAlert({ severity: 'high', kind: 'report', code: 'report_many', params: { n: reporters, text, reporter: ev.reporterName || '—' }, steamid: id, name: ev.name, evidence: lv.reports });
    } else {
      addAlert({ severity: 'low', kind: 'report', code: 'report', params: { reporter: ev.reporterName || '—', text }, steamid: id, name: ev.name });
    }
  }

  if (ev.type === 'hit') {
    rec.totals.hits++;
    if (ev.headshot) rec.totals.headshots++;
    rec.totals.longest = Math.max(rec.totals.longest || 0, ev.distance || 0);
    lv.hits.push({ t, headshot: !!ev.headshot, distance: ev.distance, weapon: ev.weapon });
    if (lv.hits.length > 60) lv.hits.shift();
    const window = lv.hits.slice(-50);
    const hs = window.filter(h => h.headshot).length / window.length;
    if (window.length >= s.minHits && hs >= s.headshotRatio && !onCooldown(`hs:${id}`, 30)) {
      addAlert({
        severity: hs >= Math.min(0.95, s.headshotRatio + 0.15) ? 'high' : 'medium', kind: 'aim', code: 'aim',
        params: { pct: Math.round(hs * 100), hits: window.length, threshold: Math.round(s.headshotRatio * 100) },
        steamid: id, name: ev.name, evidence: window.slice(-15),
      });
    }
    const limit = SHORT_RANGE.test(ev.weapon || '') ? s.shortWeaponShot : s.longShot;
    if (ev.distance >= limit && !onCooldown(`long:${id}`, 10)) {
      addAlert({
        severity: ev.headshot || ev.distance >= limit * 1.5 ? 'high' : 'medium', kind: 'distance', code: ev.headshot ? 'distance_head' : 'distance',
        params: { m: Math.round(ev.distance), weapon: ev.weapon, victim: ev.victimName, limit },
        steamid: id, name: ev.name, evidence: ev,
      });
    }
  }

  if (ev.type === 'kill') {
    rec.totals.kills++;
    lv.kills.push({ t, victim: ev.victimName, weapon: ev.weapon, distance: ev.distance });
    prune(lv.kills, 10 * 60000);
    if (lv.kills.length >= s.killsPer10Min && !onCooldown(`kills:${id}`, 15)) {
      addAlert({ severity: 'medium', kind: 'kills', code: 'kills', params: { n: lv.kills.length }, steamid: id, name: ev.name, evidence: lv.kills.slice(-10) });
    }
  }
  rec.lastSeen = t;
  scheduleSave();
}

// ---------- Registro del servidor (funciona sin plugins) ----------
const LOG_PATTERNS = [
  { re: /kick(?:ing|ed)?[^\n]*\b(fly ?hack|speed ?hack|no ?clip|eye ?hack|projectile ?hack|melee ?hack|attack ?hack|tick ?hack|inside ?terrain)/i, code: 'log_kick', severity: 'medium' },
  { re: /\b(antihack|fly ?hack|speed ?hack|no ?clip violation|eye ?hack|projectile ?hack)\b/i, code: 'log_antihack', severity: 'low' },
];
function handleLogLine(line) {
  if (!settings().enabled || bridgeLoaded) return; // con el complemento cargado ya llegan los eventos detallados
  for (const p of LOG_PATTERNS) {
    const m = line.match(p.re);
    if (m) {
      if (!onCooldown('log:' + line.slice(0, 60), 2)) {
        const sid = line.match(/\b(7656\d{13})\b/)?.[1] || null;
        addAlert({ severity: p.severity, kind: 'log', code: p.code, params: { line: line.trim().slice(0, 300) }, steamid: sid });
      }
      return;
    }
  }
}

// ---------- Lista de jugadores: IPs compartidas y evasión de baneos ----------
async function pollPlayers() {
  if (!rcon.isConnected()) { bridgeLoaded = false; return; }
  let list;
  try { list = JSON.parse(await rcon.command('playerlist')); } catch { return; }
  const s = settings();
  for (const p of list || []) {
    const id = String(p.SteamID);
    if (!/^\d{17}$/.test(id)) continue;
    const rec = playerRec(id, p.DisplayName);
    rec.lastSeen = Date.now();
    queueSteam(id, p.DisplayName);
    checkBanlist(id, p.DisplayName);
    const ip = String(p.Address || '').replace(/:\d+$/, '');
    if (ip) queueIp(id, p.DisplayName, ip);
    if (ip && !rec.ips.includes(ip)) { rec.ips.push(ip); if (rec.ips.length > 10) rec.ips.shift(); }
    if (!s.enabled || !s.sharedIp || !ip) continue;
    const others = Object.entries(players).filter(([oid, o]) => oid !== id && o.ips.includes(ip));
    for (const [oid, o] of others) {
      if (o.banned && !onCooldown(`evade:${id}:${oid}`, 24 * 60)) {
        addAlert({ severity: 'high', kind: 'evasion', code: 'evasion', params: { other: o.names.at(-1) || oid, otherId: oid }, steamid: id, name: p.DisplayName, evidence: { ip, banned: oid } });
      } else if (!o.banned && !onCooldown(`shared:${[id, oid].sort().join(':')}`, 7 * 24 * 60)) {
        addAlert({ severity: 'low', kind: 'shared-ip', code: 'shared_ip', params: { other: o.names.at(-1) || oid, otherId: oid }, steamid: id, name: p.DisplayName, evidence: { ip, other: oid } });
      }
    }
  }
  scheduleSave();
}

async function syncBans() {
  if (!rcon.isConnected()) return;
  try {
    const out = await rcon.command('banlistex');
    try { require('./banlist').ingestServerBans(out); } catch {}
    const ids = new Set([...out.matchAll(/\b(7656\d{13})\b/g)].map(m => m[1]));
    for (const [id, p] of Object.entries(players)) p.banned = ids.has(id);
    for (const id of ids) playerRec(id).banned = true;
    scheduleSave();
  } catch {}
}
let banSyncTimer = null;
function markBanned(steamid, banned = true) {
  playerRec(steamid).banned = banned; scheduleSave();
  // La lista compartida se actualiza enseguida con el motivo y la caducidad que guarda Rust
  clearTimeout(banSyncTimer); banSyncTimer = setTimeout(() => syncBans(), 2500);
}

// ---------- Perfiles de Steam ----------
const steamQueue = [];
const steamDone = new Map(); // steamid -> momento de la última comprobación en esta sesión
let steamBusy = false;

function queueSteam(id, name) {
  const st = steam.settings();
  if (!st.enabled || !st.apiKey || steam.isWhitelisted(id)) return;
  if (Date.now() - (steamDone.get(id) || 0) < 6 * 3600000) return;
  if (steamQueue.some(q => q.id === id)) return;
  steamDone.set(id, Date.now());
  steamQueue.push({ id, name });
  pumpSteam();
}
async function pumpSteam() {
  if (steamBusy || !steamQueue.length) return;
  steamBusy = true;
  const { id, name } = steamQueue.shift();
  try {
    const prof = await steam.profile(id);
    const findings = steam.evaluate(prof);
    const lang = config.get().panel.notifyLang || 'es';
    for (const f of findings) {
      let kicked = false;
      if (f.mode === 'kick' && rcon.isConnected()) {
        const reason = tr(lang, 'kick.' + f.code, f.params).replace(/"/g, "'");
        try { await rcon.command(`kick ${id} "${reason}"`); kicked = true; } catch {}
      }
      if (!onCooldown(`${f.code}:${id}`, 24 * 60)) {
        addAlert({ severity: f.severity, kind: 'steam', code: f.code, params: { ...f.params, action: kicked ? { k: 'alert.kicked' } : '' }, steamid: id, name, evidence: prof });
      }
    }
  } catch (e) {
    steamDone.delete(id);
    if (!onCooldown('steam-error', 30)) log('panel', L('steam_error', { error: errParam(e) }));
  }
  setTimeout(() => { steamBusy = false; pumpSteam(); }, 1100);
}


// ---------- Baneos compartidos (listas externas) ----------
function checkBanlist(id, name) {
  require('./banlist').onPlayerSeen(id, name, {
    addAlert: (a) => { if (!onCooldown(`banlist:${id}:${a.params.source}`, 24 * 60)) addAlert(a); },
    kick: async (pid, reason) => { if (!rcon.isConnected()) throw new Error('offline'); await rcon.command(`kick ${pid} "${String(reason || 'Banned').replace(/"/g, "'").slice(0, 120)}"`); },
  }).catch(() => {});
}

// ---------- VPN, proxy y país (reputación de la IP) ----------
const ipQueue = [];
const ipDone = new Map(); // "steamid|ip" -> momento de la comprobación en esta sesión
let ipBusy = false;
function queueIp(id, name, ip) {
  const s = ipcheck.settings();
  if (!s.enabled || ipcheck.isWhitelisted(id) || steam.isWhitelisted(id) || ipcheck.isPrivate(ip)) return;
  const key = id + '|' + ip;
  if (Date.now() - (ipDone.get(key) || 0) < 6 * 3600000) return;
  if (ipQueue.some(q => q.key === key)) return;
  ipDone.set(key, Date.now());
  ipQueue.push({ key, id, name, ip });
  pumpIp();
}
async function pumpIp() {
  if (ipBusy || !ipQueue.length) return;
  ipBusy = true;
  const { key, id, name, ip } = ipQueue.shift();
  try {
    const r = await ipcheck.lookup(ip);
    const lang = config.get().panel.notifyLang || 'es';
    let kicked = false;
    for (const f of ipcheck.evaluate(r)) {
      if (f.mode === 'kick' && !kicked && rcon.isConnected()) {
        const reason = tr(lang, 'kick.' + f.code, f.params).replace(/"/g, "'");
        try { await rcon.command(`kick ${id} "${reason}"`); kicked = true; } catch {}
      }
      if (!onCooldown(`${f.code}:${id}`, 24 * 60)) {
        // La IP no se muestra en la alerta (solo el tipo, el proveedor y el país); queda en la ficha del jugador
        addAlert({ severity: f.severity, kind: 'ip', code: f.code, params: { ...f.params, action: kicked ? { k: 'alert.kicked' } : '' }, steamid: id, name, evidence: { provider: r.provider, country: r.country, vpn: r.vpn, proxy: r.proxy, tor: r.tor, hosting: r.hosting } });
      }
    }
  } catch (e) {
    ipDone.delete(key);
    if (!onCooldown('ipcheck-error', 30)) log('panel', L('ipcheck_error', { error: errParam(e) }));
  }
  setTimeout(() => { ipBusy = false; pumpIp(); }, 1500);
}

// ---------- Equipos y armarios compartidos ----------
let teamsSnapshot = null;

// Une jugadores que están en el mismo equipo o autorizados en el mismo armario
function groupPlayers(d) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const shared = new Map(); // raíz -> nº de armarios compartidos
  for (const t of d.teams || []) { const m = t.members.map(x => x.steamid); m.forEach(add); m.slice(1).forEach(x => union(m[0], x)); }
  for (const c of d.cupboards || []) { const a = c.authed || []; a.forEach(add); a.slice(1).forEach(x => union(a[0], x)); }
  for (const c of d.cupboards || []) if ((c.authed || []).length > 1) { const r = find(c.authed[0]); shared.set(r, (shared.get(r) || 0) + 1); }
  const groups = new Map();
  for (const x of parent.keys()) { const r = find(x); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x); }
  return [...groups.entries()].filter(([, m]) => m.length > 1).map(([r, m]) => {
    const inGroup = (d.teams || []).filter(t => t.members.some(x => m.includes(x.steamid)));
    // Es "solo un equipo" si el grupo coincide exactamente con los miembros de un único equipo
    const pureTeam = inGroup.length === 1 && inGroup[0].members.length === m.length;
    return { members: m, cupboards: [...(d.cupboards || [])].filter(c => (c.authed || []).some(x => m.includes(x))).length, teams: inGroup.length, pureTeam };
  });
}

async function pollTeams() {
  if (!bridgeLoaded || !rcon.isConnected()) return;
  let d;
  try { d = await rconJson('scrapwarden.teams'); } catch { return; }
  for (const t of d.teams || []) for (const m of t.members) playerRec(m.steamid, m.name);
  const s = settings();
  const limit = s.teamLimit || 0;
  const groups = groupPlayers(d);
  teamsSnapshot = { t: Date.now(), teams: d.teams || [], groups, limit };
  if (!s.enabled || !limit) return;
  const names = (ids) => ids.slice(0, 8).map(displayName).join(', ') + (ids.length > 8 ? '…' : '');
  for (const t of d.teams || []) {
    if (t.members.length > limit && !onCooldown(`team:${t.id}:${t.members.length}`, 60)) {
      const leader = t.members.find(m => m.steamid === t.leader) || t.members[0];
      addAlert({ severity: 'high', kind: 'team', code: 'team_size', params: { n: t.members.length, limit, names: names(t.members.map(m => m.steamid)) }, steamid: leader.steamid, name: leader.name, evidence: t });
    }
  }
  if (s.cupboardGroups) {
    for (const g of groups) {
      if (g.members.length > limit && !g.pureTeam && !onCooldown('group:' + [...g.members].sort().join(','), 6 * 60)) {
        addAlert({ severity: 'medium', kind: 'team', code: 'team_group', params: { n: g.members.length, limit, names: names(g.members), tcs: g.cupboards }, steamid: g.members[0], evidence: g });
      }
    }
  }
  scheduleSave();
}

function teamsView() {
  if (!teamsSnapshot) return { t: null, teams: [], groups: [], limit: settings().teamLimit || 0 };
  const limit = settings().teamLimit || 0;
  const nm = (id) => ({ steamid: id, name: displayName(id) });
  return {
    t: teamsSnapshot.t, limit,
    teams: teamsSnapshot.teams.map(t => ({ ...t, over: !!limit && t.members.length > limit })).sort((a, b) => b.members.length - a.members.length),
    groups: teamsSnapshot.groups.filter(g => !g.pureTeam).map(g => ({ ...g, members: g.members.map(nm), over: !!limit && g.members.length > limit })).sort((a, b) => b.members.length - a.members.length),
  };
}

// ---------- Resumen por jugador ----------
function suspects() {
  const scoreSev = { high: 10, medium: 4, low: 1 };
  const byPlayer = {};
  for (const a of alerts) {
    if (!a.steamid || a.status === 'dismissed') continue;
    byPlayer[a.steamid] = (byPlayer[a.steamid] || 0) + scoreSev[a.severity] * (a.status === 'new' ? 1 : 0.4);
  }
  const ids = new Set([...Object.keys(byPlayer), ...[...live.keys()].filter(id => live.get(id).hits.length >= 10)]);
  return [...ids].map(id => {
    const p = players[id] || { names: [], totals: {} };
    const lv = live.get(id);
    const hits = lv?.hits || [];
    return {
      steamid: id, name: p.names.at(-1) || id, banned: !!p.banned,
      score: Math.round(byPlayer[id] || 0),
      hits: hits.length, headshotPct: hits.length ? Math.round(hits.filter(h => h.headshot).length / hits.length * 100) : null,
      longest: Math.round(p.totals?.longest || 0),
      violations10m: lv ? lv.violations.filter(v => v.t > Date.now() - 600000).length : 0,
      reports: p.totals?.reports || 0,
      lastSeen: p.lastSeen,
    };
  }).sort((a, b) => b.score - a.score || (b.headshotPct || 0) - (a.headshotPct || 0)).slice(0, 50);
}

function playerInfo(steamid) {
  const p = players[steamid];
  if (!p) return steam.cached(steamid) ? { steamid, names: [], ips: [], steam: steam.cached(steamid), alerts: listAlerts({ steamid, limit: 50 }) } : null;
  return { steamid, ...p, steam: steam.cached(steamid), alerts: listAlerts({ steamid, limit: 50 }) };
}

// ---------- Complemento ----------
function bridgeInstalled() {
  try { return fs.existsSync(path.join(plugins.dirs().plugins, 'ScrapwardenBridge.cs')); } catch { return false; }
}
const verOf = (src) => (/\[Info\(\s*"ScrapwardenBridge"\s*,\s*"[^"]*"\s*,\s*"([\d.]+)"/.exec(src || '') || [])[1] || null;
const BUNDLED_VERSION = verOf(fs.readFileSync(BRIDGE_SRC, 'utf8'));
let bridgeVersion = null, bridgeError = null;

function installedBridgeVersion() {
  try { return verOf(fs.readFileSync(path.join(plugins.dirs().plugins, 'ScrapwardenBridge.cs'), 'utf8')); } catch { return null; }
}
// Nombres anteriores del complemento (RustPanelBridge y OxidianBridge): se eliminan al instalar el nuevo,
// porque dos copias cargadas a la vez duplicarían eventos y comandos
const LEGACY_BRIDGES = ['RustPanelBridge.cs', 'OxidianBridge.cs'];
function removeLegacyBridge() {
  for (const name of LEGACY_BRIDGES) {
    try {
      const old = path.join(plugins.dirs().plugins, name);
      if (fs.existsSync(old)) { fs.rmSync(old); log('panel', L('bridge_legacy_removed')); }
    } catch {}
  }
}
async function installBridge() {
  if (config.isRemote() && !files.available()) throw E('remote_bridge_manual');
  const src = fs.readFileSync(BRIDGE_SRC, 'utf8');
  if (config.isRemote()) await removeRemoteLegacyBridge(); else removeLegacyBridge();
  await plugins.writePlugin('ScrapwardenBridge', src);
  bridgeError = null;
  if (config.isRemote()) remoteBridgeVersion = BUNDLED_VERSION;
  log('panel', L('bridge_installed'));
}
// En remoto con FTP/SFTP: se lee la versión subida y se reemplaza si es otra
let remoteBridgeVersion = null;
async function removeRemoteLegacyBridge() {
  for (const name of LEGACY_BRIDGES) {
    try { const F = files.current(); const f = `${plugins.rel().plugins}/${name}`; if (await F.exists(f)) { await F.remove(f); log('panel', L('bridge_legacy_removed')); } } catch {}
  }
}
async function ensureRemoteBridge() {
  const F = files.current();
  await removeRemoteLegacyBridge();
  let cur = null;
  try { cur = verOf((await F.read(`${plugins.rel().plugins}/ScrapwardenBridge.cs`)).toString('utf8')); } catch {}
  remoteBridgeVersion = cur;
  if (cur === BUNDLED_VERSION) return false;
  await installBridge();
  log('panel', L(cur ? 'bridge_updated' : 'bridge_auto', { from: cur || '', to: BUNDLED_VERSION }));
  return true;
}
// Con Oxide o Carbon, instala el complemento si falta o lo actualiza si es de otra versión
// (Oxide y Carbon lo recompilan y recargan solos al cambiar el archivo, sin reiniciar)
async function ensureBridge() {
  const fw = config.get().server.framework;
  if (!['oxide', 'carbon'].includes(fw)) return false;
  try {
    if (config.isRemote()) return files.available() ? await ensureRemoteBridge() : false;
    if (!fs.existsSync(config.serverPaths().exe)) return false;
    removeLegacyBridge();
    const cur = installedBridgeVersion();
    if (cur === BUNDLED_VERSION) return false;
    await installBridge();
    log('panel', L(cur ? 'bridge_updated' : 'bridge_auto', { from: cur || '', to: BUNDLED_VERSION }));
    return true;
  } catch (e) { log('panel', L('bridge_auto_failed', { error: errParam(e) })); return false; }
}
async function checkBridge() {
  if (!rcon.isConnected()) return (bridgeLoaded = false);
  try {
    const out = await rcon.command('scrapwarden.ping', 4000);
    bridgeLoaded = /"ok":\s*true/.test(out);
    try { bridgeVersion = JSON.parse(out).version || null; } catch { bridgeVersion = null; }
    if (bridgeLoaded) bridgeError = null;
  } catch { bridgeLoaded = false; }
  return bridgeLoaded;
}
function bridgeInfo() {
  const fw = config.get().server.framework;
  const remote = config.isRemote();
  const installed = !['oxide', 'carbon'].includes(fw) ? null : remote ? remoteBridgeVersion : installedBridgeVersion();
  return {
    remote, files: files.available(), // en remoto sin FTP/SFTP el complemento se sube a mano
    framework: fw, installed: !!installed, installedVersion: installed, bundled: BUNDLED_VERSION,
    loaded: bridgeLoaded, version: bridgeVersion,
    outdated: !!(bridgeLoaded && bridgeVersion && bridgeVersion !== BUNDLED_VERSION),
    error: bridgeError,
  };
}
function status() {
  let framework = config.get().server.framework;
  return {
    framework, installed: ['oxide', 'carbon'].includes(framework) && bridgeInstalled(),
    loaded: bridgeLoaded, unread: unread(), settings: settings(),
  };
}

// ---------- Inventario ----------
async function rconJson(cmd, timeoutMs) {
  const out = await rcon.command(cmd, timeoutMs);
  let j;
  try { j = JSON.parse(out); } catch {
    throw (/not found|unknown/i.test(out || '') || !out ? E('bridge_missing') : E('bridge_unexpected', { out: String(out).slice(0, 120) }));
  }
  if (j.error) throw E('bridge_' + j.error);
  return j;
}
const inventory = (id) => rconJson(`scrapwarden.inventory ${id}`);
const removeItem = (id, container, slot) => {
  if (!['main', 'belt', 'wear'].includes(container)) throw E('bad_container');
  return rconJson(`scrapwarden.inventory.remove ${id} ${container} ${parseInt(slot, 10)}`);
};
const clearInventory = (id) => rconJson(`scrapwarden.inventory.clear ${id}`);

// ---------- Arranque ----------
function start() {
  load();
  bus.on('bridge', handleBridgeEvent);
  bus.on('serverline', handleLogLine);
  bus.on('rcon', ({ connected }) => {
    if (connected) {
      // En remoto se espera a que el panel detecte Oxide o Carbon por RCON
      setTimeout(async () => {
        const updated = await ensureBridge();
        // Si se acaba de escribir, se da tiempo a Oxide/Carbon para compilarlo
        setTimeout(async () => { await checkBridge(); syncBans(); pollPlayers(); pollTeams(); }, updated ? 12000 : 3000);
      }, config.isRemote() ? 5000 : 0);
    } else bridgeLoaded = false;
  });
  // Errores de compilación del complemento en la consola del servidor (Oxide y Carbon)
  bus.on('console', (e) => {
    if (e.source !== 'server' || !/ScrapwardenBridge/.test(e.line || '')) return;
    if (/error|failed|exception|could not|unable/i.test(e.line)) bridgeError = { t: e.t, line: String(e.line).slice(0, 400) };
    else if (/loaded plugin|successfully compiled|loaded/i.test(e.line)) setTimeout(checkBridge, 1500);
  });
  ensureBridge().catch(() => {});
  setInterval(() => pollPlayers().catch(() => {}), 30000);
  setInterval(() => { syncBans(); checkBridge(); }, 3 * 60000);
  setInterval(() => pollTeams().catch(() => {}), 2 * 60000);
}

module.exports = {
  start, status, listAlerts, setStatus, markAll, clearReviewed, suspects, playerInfo,
  installBridge, checkBridge, inventory, removeItem, clearInventory, markBanned, sendDiscord,
  teamsView, pollTeams, rconJson, syncBans, isBridgeLoaded: () => bridgeLoaded, displayName, bridgeInfo, ensureBridge,
  discordWebhook: () => settings().discordWebhook || '',
  checkSteamNow: async (id) => { const p = await steam.profile(id, { force: true }); return { profile: p, findings: steam.evaluate(p) }; },
  update: (v) => config.update('watch', v), DEFAULTS,
};
