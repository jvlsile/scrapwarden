// VIP con caducidad: mete a un jugador en un grupo de Oxide/Carbon durante X días y lo saca solo al vencer.
// El panel guarda la fecha de fin; si el servidor está apagado al vencer, lo quita en cuanto vuelve.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const plugins = require('./plugins');
const watch = require('./watch');
const { bus, log } = require('./bus');
const { E, L, tr } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'vip.json');
const DAY = 86400000;
const DEFAULTS = { groups: ['vip'], defaultGroup: 'vip', defaultDays: 30, notify: true, warnHours: 24, skipQueue: true };
const SKIP_PERM = 'scrapwarden.skipqueue';
let db = { grants: [], history: [] };
let timer = null;

const settings = () => ({ ...DEFAULTS, ...(config.get().vip || {}) });
const lang = () => config.get().panel.notifyLang || 'es';
const now = () => Date.now();
function load() { try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { db.history = db.history.slice(-1000); fs.writeFileSync(FILE, JSON.stringify(db)); }
const groupOk = (g) => /^[\w.\-]{1,40}$/.test(g || '');
const idOk = (id) => /^\d{17}$/.test(String(id || ''));
const cmdPre = () => plugins.dirs().cmd;
const key = (id, group) => `${id}:${group}`;

async function pmPlayer(id, k, p) {
  if (!settings().notify || !rcon.isConnected() || !watch.isBridgeLoaded()) return false;
  const msg = Buffer.from(tr(lang(), k, p)).toString('base64');
  return watch.rconJson(`scrapwarden.pm ${id} ${msg}`, 5000).then(() => true).catch(() => false);
}

async function addToGroup(id, group) {
  if (!rcon.isConnected()) return false;
  await rcon.command(`${cmdPre()}group add ${group}`).catch(() => {}); // si ya existe no pasa nada
  if (settings().skipQueue) await rcon.command(`${cmdPre()}grant group ${group} ${SKIP_PERM}`).catch(() => {});
  await rcon.command(`${cmdPre()}usergroup add ${id} ${group}`);
  return true;
}
async function removeFromGroup(id, group) {
  if (!rcon.isConnected()) return false;
  await rcon.command(`${cmdPre()}usergroup remove ${id} ${group}`);
  return true;
}

// ---------- Acciones ----------
async function grant({ steamid, name, group, days, note = '' }, by) {
  const s = settings();
  const id = String(steamid || '').trim();
  if (!idOk(id)) throw E('bad_steamid');
  group = String(group || s.defaultGroup).trim();
  if (!groupOk(group)) throw E('bad_value', { value: group });
  days = Number(days);
  const permanent = days === 0;
  if (!permanent && !(days > 0 && days <= 3650)) throw E('vip_bad_days');
  const pname = String(name || (watch.displayName ? watch.displayName(id) : '') || id).slice(0, 64);
  let g = db.grants.find(x => x.steamid === id && x.group === group);
  const extending = !!g;
  if (g) {
    // Ya era VIP: se suma tiempo desde el final actual (o pasa a permanente)
    g.until = permanent ? null : Math.max(now(), g.until || now()) + days * DAY;
    if (permanent) g.until = null;
    g.warned = false; g.name = pname;
    g.log.push({ t: now(), by, action: 'extend', days });
  } else {
    g = { steamid: id, name: pname, group, since: now(), until: permanent ? null : now() + days * DAY, by, note: String(note).slice(0, 200), synced: false, warned: false, log: [{ t: now(), by, action: 'grant', days }] };
    db.grants.push(g);
  }
  g.synced = await addToGroup(id, group).catch(() => false);
  save();
  log('panel', L(permanent ? 'vip_granted_perm' : extending ? 'vip_extended' : 'vip_granted', { name: pname, group, n: days }));
  await pmPlayer(id, permanent ? 'game.vip_granted_perm' : extending ? 'game.vip_extended' : 'game.vip_granted', { group, n: days, until: g.until ? new Date(g.until).toLocaleDateString(lang()) : '' });
  emit();
  return view();
}

async function revoke(steamid, group, by, reason = 'removed') {
  const g = db.grants.find(x => x.steamid === steamid && x.group === group);
  if (!g) throw E('vip_not_found');
  const ok = await removeFromGroup(steamid, group).catch(() => false);
  if (!ok) { g.pendingRemove = true; g.removeReason = reason; save(); return view(); }
  db.grants = db.grants.filter(x => x !== g);
  db.history.push({ steamid, name: g.name, group, since: g.since, ended: now(), by, reason });
  save();
  log('panel', L(reason === 'expired' ? 'vip_expired' : 'vip_removed', { name: g.name, group }));
  if (reason === 'expired') await pmPlayer(steamid, 'game.vip_expired', { group });
  emit();
  return view();
}

// ---------- Bucle: caducidades, avisos y sincronización ----------
async function tick() {
  if (!rcon.isConnected()) return;
  const s = settings();
  const t = now();
  for (const g of [...db.grants]) {
    try {
      if (g.pendingRemove || (g.until && g.until <= t)) { await revoke(g.steamid, g.group, 'system', g.pendingRemove ? g.removeReason || 'removed' : 'expired'); continue; }
      if (!g.synced) { g.synced = await addToGroup(g.steamid, g.group).catch(() => false); save(); }
      if (g.until && !g.warned && s.warnHours > 0 && g.until - t <= s.warnHours * 3600000) {
        // Solo se marca como avisado si el jugador estaba conectado y le llegó el mensaje
        if (await pmPlayer(g.steamid, 'game.vip_ending', { group: g.group, n: Math.max(1, Math.round((g.until - t) / 3600000)) })) { g.warned = true; save(); }
      }
    } catch {}
  }
}

function emit() { bus.emit('vip', { active: db.grants.length }); }

function view() {
  const t = now();
  return {
    settings: settings(),
    grants: db.grants.map(g => ({ steamid: g.steamid, name: g.name, group: g.group, since: g.since, until: g.until, by: g.by, note: g.note, synced: !!g.synced, pendingRemove: !!g.pendingRemove, expiring: !!(g.until && g.until - t < 3 * DAY) }))
      .sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity)),
    history: db.history.slice(-100).reverse(),
  };
}

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  if (Array.isArray(input.groups)) {
    const gs = [...new Set(input.groups.map(x => String(x).trim()).filter(Boolean))];
    if (!gs.length || gs.some(x => !groupOk(x))) throw E('bad_value', { value: gs.join(',') });
    out.groups = gs.slice(0, 20);
  }
  if (input.defaultGroup !== undefined) { if (!groupOk(input.defaultGroup)) throw E('bad_value', { value: input.defaultGroup }); out.defaultGroup = String(input.defaultGroup); }
  if (!out.groups.includes(out.defaultGroup)) out.groups.unshift(out.defaultGroup);
  if (input.defaultDays !== undefined) out.defaultDays = Math.max(1, Math.min(3650, Math.round(Number(input.defaultDays) || 30)));
  if (input.warnHours !== undefined) out.warnHours = Math.max(0, Math.min(168, Math.round(Number(input.warnHours) || 0)));
  if (input.notify !== undefined) out.notify = !!input.notify;
  if (input.skipQueue !== undefined) out.skipQueue = !!input.skipQueue;
  const skipChanged = out.skipQueue !== cur.skipQueue || out.groups.join() !== cur.groups.join();
  config.update('vip', out);
  if (skipChanged) applySkipQueue().catch(() => {});
  return view();
}

// Da o quita la prioridad en la cola a todos los grupos VIP (necesita ScrapwardenBridge 1.6.1)
async function applySkipQueue() {
  if (!rcon.isConnected()) return false;
  const s = settings();
  for (const g of s.groups) {
    await rcon.command(`${cmdPre()}group add ${g}`).catch(() => {});
    await rcon.command(`${cmdPre()}${s.skipQueue ? 'grant' : 'revoke'} group ${g} ${SKIP_PERM}`).catch(() => {});
  }
  return true;
}

const isVip = (id) => db.grants.filter(g => g.steamid === id).map(g => ({ group: g.group, until: g.until }));

function start() {
  load();
  timer = setInterval(() => tick().catch(() => {}), 60000);
  // Al reconectar se vuelven a aplicar los grupos (por si se restauró una copia o se borraron datos de Oxide)
  bus.on('rcon', ({ connected }) => { if (connected) { db.grants.forEach(g => { g.synced = false; }); setTimeout(() => { applySkipQueue().catch(() => {}); tick().catch(() => {}); }, 15000); } });
}

module.exports = { start, grant, revoke, view, update, isVip, tick, DEFAULTS };
