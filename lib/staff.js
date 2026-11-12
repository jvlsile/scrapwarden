// Staff en el juego: el panel decide quién es moderador o admin dentro del servidor (permisos scrapwarden.mod /
// scrapwarden.admin de ScrapwardenBridge), le manda los tickets y textos, y ejecuta las sanciones que piden con /staff.
// Así todo lo que se hace en el juego queda en la ficha del jugador y en el registro de actividad del panel.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const plugins = require('./plugins');
const watch = require('./watch');
const moderation = require('./moderation');
const tickets = require('./tickets');
const world = require('./world');
const audit = require('./audit');
const { bus, log } = require('./bus');
const { E, L, tr, errParam } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'staff.json');
const PERM = { mod: 'scrapwarden.mod', admin: 'scrapwarden.admin' };
let db = { members: [], revoke: [] };
let pushTimer = null;

const lang = () => config.get().panel.notifyLang || 'es';
function load() { try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { fs.writeFileSync(FILE, JSON.stringify(db)); }
const b64 = (s) => Buffer.from(s).toString('base64');
const ready = () => rcon.isConnected() && watch.isBridgeLoaded();

// Qué puede pedir cada nivel desde el juego (el complemento ya lo comprueba; aquí se vuelve a comprobar)
const MOD_ACTIONS = ['tp', 'warn', 'mute', 'unmute', 'kick'];
const ADMIN_ACTIONS = ['bring', 'heal', 'tempban1', 'tempban7', 'ban', 'world'];
const TICKET_RES = { mod: ['none', 'warn', 'kick'], admin: ['none', 'warn', 'kick', 'tempban'] };

// ---------- Permisos en el servidor ----------
async function sync() {
  if (!ready()) return false;
  const pre = plugins.dirs().cmd;
  for (const id of db.revoke) {
    await rcon.command(`${pre}revoke user ${id} ${PERM.mod}`).catch(() => {});
    await rcon.command(`${pre}revoke user ${id} ${PERM.admin}`).catch(() => {});
  }
  db.revoke = [];
  for (const m of db.members) {
    await rcon.command(`${pre}grant user ${m.steamid} ${PERM.mod}`).catch(() => {});
    await rcon.command(`${pre}${m.level === 'admin' ? 'grant' : 'revoke'} user ${m.steamid} ${PERM.admin}`).catch(() => {});
    m.synced = true;
  }
  save();
  await push();
  return true;
}

// ---------- Datos para la ventana /staff ----------
function strings() {
  const out = {};
  const keys = ['title', 'lvl.mod', 'lvl.admin', 'tab.players', 'tab.reports', 'tab.world', 'close', 'pick', 'health', 'warns', 'team', 'muted', 'sleeping', 'reason',
    'a.tp', 'a.bring', 'a.heal', 'a.warn', 'a.mute', 'a.unmute', 'a.kick', 'a.tempban1', 'a.tempban7', 'a.ban', 'confirm', 'noReports', 'rep.line',
    'r.none', 'r.warn', 'r.kick', 'r.tempban', 'w.time', 'w.day', 'w.night', 'w.weather', 'w.clear', 'w.storm', 'w.events', 'w.cargo', 'w.heli', 'w.airdrop', 'w.chinook',
    'sent', 'noperm', 'offline', 'notify', 'done.tp', 'done.bring', 'done.heal'];
  // Los textos con {name}/{n}/{r} se dejan tal cual: los rellena el complemento
  const keep = { name: '{name}', n: '{n}', r: '{r}' };
  for (const k of keys) out[k] = tr(lang(), 'ig.' + k, keep);
  return out;
}
async function push() {
  if (!ready()) return false;
  const tk = tickets.list('active').items.slice(0, 20).map(t => ({ id: t.id, sid: t.target.id, name: t.target.name, n: t.reports, r: t.reporters, subj: t.lastSubject }));
  const warns = {};
  for (const [id, s] of Object.entries(moderation.summary())) if (s.warnings) warns[id] = s.warnings;
  const data = { t: strings(), tickets: tk, warns };
  await watch.rconJson(`scrapwarden.staffdata ${b64(JSON.stringify(data))}`, 6000).catch(() => {});
  return true;
}
function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => push().catch(() => {}), 1500); }

// ---------- Acciones pedidas desde el juego ----------
const reply = (id, key, p) => watch.rconJson(`scrapwarden.pm ${id} ${b64(tr(lang(), key, p))}`, 5000).catch(() => {});

async function onAction(ev) {
  const by = String(ev.by || ''), byName = String(ev.byName || by).slice(0, 64);
  const m = db.members.find(x => x.steamid === by);
  if (!m) return; // alguien con el permiso puesto a mano pero que no está en la lista del panel: se ignora
  const action = String(ev.action || '');
  const allowed = m.level === 'admin' ? [...MOD_ACTIONS, ...ADMIN_ACTIONS, 'ticket'] : [...MOD_ACTIONS, 'ticket'];
  if (!allowed.includes(action)) return;
  const target = String(ev.target || ''), tname = String(ev.targetName || target).slice(0, 64);
  const reason = String(ev.reason || '').trim().slice(0, 100) || tr(lang(), 'ig.defaultReason', { name: byName });
  const user = `ingame:${byName}`;
  const rec = (ok, details, extra = {}) => audit.record({ user, action: 'ingame_' + action, target: target || null, details, ok, ...extra });
  try {
    if (['tp', 'bring', 'heal'].includes(action)) { rec(true, tname); return; } // ya hecho por el complemento: solo se registra
    if (target && !/^\d{17}$/.test(target)) throw E('bad_steamid');
    if (action === 'warn') await moderation.warn(target, { reason, by: user, name: tname });
    else if (action === 'mute') await moderation.mute(target, { minutes: 30, reason, by: user, name: tname });
    else if (action === 'unmute') await moderation.unmute(target);
    else if (action === 'kick') await rcon.command(`kick ${target} "${reason.replace(/"/g, "'")}"`);
    else if (action === 'tempban1' || action === 'tempban7') await moderation.tempban(target, { minutes: action === 'tempban1' ? 1440 : 10080, reason, by: user, name: tname });
    else if (action === 'ban') {
      await rcon.command(`banid ${target} "${tname.replace(/"/g, "'")}" "${reason.replace(/"/g, "'")}"`);
      await rcon.command(`kick ${target} "${reason.replace(/"/g, "'")}"`).catch(() => {});
      await rcon.command('server.writecfg').catch(() => {});
      watch.markBanned(target, true);
    } else if (action === 'ticket') {
      const res = String(ev.resolution || '');
      if (!TICKET_RES[m.level].includes(res)) return;
      await tickets.close(Number(ev.ticket), user, { resolution: res, minutes: 1440, note: ev.reason || '', notify: true });
    } else if (action === 'world') {
      const w = String(ev.what || '');
      if (w === 'day' || w === 'night') await world.setTime({ preset: w === 'day' ? 'noon' : 'night' });
      else if (w === 'clear' || w === 'storm') await world.setWeather(w);
      else await world.startEvent(w);
    }
    rec(true, [tname, action === 'ticket' ? `#${ev.ticket} ${ev.resolution}` : action === 'world' ? ev.what : reason].filter(Boolean).join(' · '));
    log('panel', L('staff_ingame', { by: byName, a: { k: 'ig.a.' + (action === 'ticket' ? 'ticketLog' : action === 'world' ? 'worldLog' : action) }, name: action === 'world' ? { k: 'ig.w.' + String(ev.what || '') } : tname }));
    await reply(by, 'ig.done', {});
    schedulePush();
  } catch (e) {
    rec(false, e.message);
    await reply(by, 'ig.failed', { error: e.code ? tr(lang(), 'err.' + e.code, e.params || {}) : e.message });
  }
}

// ---------- Panel ----------
function view() {
  return { members: db.members.map(m => ({ ...m, name: (watch.displayName && watch.displayName(m.steamid)) || m.name })), bridge: watch.isBridgeLoaded(), rcon: rcon.isConnected() };
}
async function add({ steamid, name, level }, by) {
  const id = String(steamid || '').trim();
  if (!/^\d{17}$/.test(id)) throw E('bad_steamid');
  if (!['mod', 'admin'].includes(level)) throw E('bad_value', { value: level });
  const cur = db.members.find(m => m.steamid === id);
  if (cur) { cur.level = level; cur.synced = false; }
  else db.members.push({ steamid: id, name: String(name || (watch.displayName && watch.displayName(id)) || id).slice(0, 64), level, since: Date.now(), by, synced: false });
  db.revoke = db.revoke.filter(x => x !== id);
  save();
  log('panel', L(cur ? 'staff_level' : 'staff_added', { name: cur ? cur.name : (name || id), l: { k: 'stf.lvl.' + level } }));
  await sync().catch(() => {});
  if (ready()) await reply(id, 'ig.welcome', { l: tr(lang(), 'ig.lvl.' + level) });
  return view();
}
async function remove(id, by) {
  const m = db.members.find(x => x.steamid === id);
  if (!m) throw E('staff_not_found');
  db.members = db.members.filter(x => x !== m);
  db.revoke.push(id);
  save();
  log('panel', L('staff_removed', { name: m.name }));
  await sync().catch(() => {});
  return view();
}

function start() {
  load();
  bus.on('bridge', (ev) => { if (ev?.type === 'staffaction') onAction(ev).catch(() => {}); });
  bus.on('tickets', schedulePush);
  bus.on('rcon', ({ connected }) => { if (connected) setTimeout(() => sync().catch(() => {}), 12000); });
  // Por si el complemento se recarga (pierde los datos en memoria) o cambia el idioma de los avisos
  setInterval(() => { if (db.members.length) push().catch(() => {}); }, 5 * 60000);
}

module.exports = { start, view, add, remove, sync, push };
