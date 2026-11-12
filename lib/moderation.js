// Moderación: historial de chat, filtro de palabras, silencios, notas, advertencias y baneos temporales
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const rcon = require('./rcon');
const watch = require('./watch');
const { bus, log } = require('./bus');
const { E, L, tr } = require('./i18n');

const CHAT_FILE = path.join(config.DATA_DIR, 'chat.json');
const MOD_FILE = path.join(config.DATA_DIR, 'moderation.json');
const MAX_CHAT = 20000;

const DEFAULTS = {
  filter: { words: [], block: true, action: 'none', muteMinutes: 15 },
  // Sanciones automáticas al acumular advertencias activas
  policy: {
    expireDays: 30,
    steps: [
      { at: 2, action: 'mute', minutes: 60 },
      { at: 3, action: 'tempban', minutes: 1440 },
      { at: 5, action: 'ban', minutes: 0 },
    ],
  },
};
const ACTIONS = ['none', 'kick', 'mute', 'tempban', 'ban'];

let chat = [];
let mod = {}; // steamid -> { notes:[], warnings:[], mute:null|{until,by,reason}, tempban:null|{until,by,reason} }
try { chat = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch { chat = []; }
try { mod = JSON.parse(fs.readFileSync(MOD_FILE, 'utf8')); } catch { mod = {}; }

const timers = {};
function saveLater(file, getter) {
  if (timers[file]) return;
  timers[file] = setTimeout(() => { timers[file] = null; fs.writeFileSync(file, JSON.stringify(getter())); }, 1500);
}
const saveChat = () => saveLater(CHAT_FILE, () => chat);
const saveMod = () => saveLater(MOD_FILE, () => mod);

const settings = () => {
  const m = config.get().moderation || {};
  return { filter: { ...DEFAULTS.filter, ...(m.filter || {}) }, policy: { ...DEFAULTS.policy, ...(m.policy || {}) } };
};
const lang = () => config.get().panel.notifyLang || 'es';
const rec = (id) => (mod[id] ||= { notes: [], warnings: [], mute: null, tempban: null });
const newId = () => crypto.randomBytes(5).toString('hex');
const q = (s) => `"${String(s || '').replace(/"/g, "'")}"`;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// ---------- Filtro de palabras ----------
const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
let filterRe = null;
function buildFilter() {
  const words = settings().filter.words.map(normalize).filter(Boolean);
  // "*" funciona como comodín: idiot* bloquea idiota, idiotas…
  filterRe = words.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map(w => escapeRe(w).replace(/\*/g, '[\\p{L}\\p{N}]*')).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
    : null;
}
buildFilter();
const matchWord = (msg) => (filterRe ? (normalize(msg).match(filterRe) || [])[2] || null : null);

// Envía la lista al complemento para que bloquee los mensajes antes de que se publiquen
async function pushFilter() {
  if (!watch.isBridgeLoaded() || !rcon.isConnected()) return;
  const f = settings().filter;
  const payload = {
    pattern: f.block && filterRe ? filterRe.source : '',
    message: tr(lang(), 'game.chat_blocked'),
    mutedMessage: tr(lang(), 'game.you_are_muted'),
  };
  try { await rcon.command(`oxidian.chatfilter ${b64(JSON.stringify(payload))}`); } catch {}
}

// ---------- Chat ----------
function addMessage(m) {
  chat.push(m);
  if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
  saveChat();
  bus.emit('chatmsg', m);
}

// Mensaje recibido por RCON (ya publicado en el juego)
async function onChat(c) {
  const id = String(c.UserId || '');
  const m = { t: Date.now(), id, name: c.Username || id, ch: c.Channel === 1 ? 'team' : 'global', msg: String(c.Message || '') };
  const word = matchWord(m.msg);
  if (word) m.word = word;
  addMessage(m);
  if (word && /^\d{17}$/.test(id)) await applyFilterAction(id, m.name, word);
}

// Mensaje bloqueado por el complemento (nadie lo ha visto)
async function onBlocked(ev) {
  const m = { t: Date.now(), id: String(ev.steamid), name: ev.name, ch: ev.channel === 1 ? 'team' : 'global', msg: String(ev.message || ''), word: ev.word || matchWord(ev.message), blocked: true };
  addMessage(m);
  await applyFilterAction(m.id, m.name, m.word);
}

async function applyFilterAction(id, name, word) {
  const f = settings().filter;
  const reason = tr(lang(), 'mod.filterReason', { word });
  try {
    if (f.action === 'warn') await warn(id, { by: 'system', reason, name });
    else if (f.action === 'mute') await mute(id, { by: 'system', minutes: f.muteMinutes, reason, name });
    else if (f.action === 'kick') await rcon.command(`kick ${id} ${q(reason)}`);
  } catch {}
}

function listChat({ q: query, steamid, ch, limit = 300, before } = {}) {
  const nq = normalize(query || '');
  const out = [];
  for (let i = chat.length - 1; i >= 0 && out.length < Math.min(1000, limit); i--) {
    const m = chat[i];
    if (before && m.t >= before) continue;
    if (steamid && m.id !== steamid) continue;
    if (ch && ch !== 'all' && m.ch !== ch && !(ch === 'flagged' && m.word)) continue;
    if (nq && !normalize(m.msg).includes(nq) && !normalize(m.name).includes(nq)) continue;
    out.push(m);
  }
  return out;
}

async function pm(id, message, by) {
  if (!watch.isBridgeLoaded()) throw E('bridge_missing');
  const text = String(message || '').trim().slice(0, 300);
  if (!text) throw E('empty_message');
  const r = await watch.rconJson(`oxidian.pm ${id} ${b64(text)}`);
  addMessage({ t: Date.now(), id: 'panel', name: by, ch: 'pm', to: id, toName: r.name || id, msg: text });
  return r;
}

async function say(message, by) {
  const text = String(message || '').trim().slice(0, 300);
  if (!text) throw E('empty_message');
  await rcon.say(text);
  addMessage({ t: Date.now(), id: 'panel', name: by, ch: 'global', msg: text, fromPanel: true });
}

// ---------- Notas ----------
function addNote(id, text, by) {
  text = String(text || '').trim().slice(0, 1000);
  if (!text) throw E('empty_note');
  const n = { id: newId(), t: Date.now(), by, text };
  rec(id).notes.unshift(n);
  saveMod();
  return n;
}
function deleteNote(id, nid) {
  const r = rec(id); const before = r.notes.length;
  r.notes = r.notes.filter(n => n.id !== nid);
  if (r.notes.length === before) throw E('not_found');
  saveMod();
}

// ---------- Silencios ----------
async function sendMute(id, on, seconds) {
  // Silencio nativo de Rust + silencio del complemento (si está cargado) para cubrir todas las versiones
  await rcon.command(`${on ? 'mutechat' : 'unmutechat'} ${id}`).catch(() => {});
  if (watch.isBridgeLoaded()) await rcon.command(`oxidian.mute ${id} ${on ? Math.max(0, seconds | 0) : -1}`).catch(() => {});
}

async function mute(id, { minutes = 15, reason = '', by, name } = {}) {
  minutes = Math.max(0, parseInt(minutes, 10) || 0);
  const r = rec(id);
  r.mute = { since: Date.now(), until: minutes ? Date.now() + minutes * 60000 : null, by, reason };
  saveMod();
  await sendMute(id, true, minutes * 60);
  notify(id, minutes ? 'game.muted_for' : 'game.muted', { n: minutes, reason });
  log('panel', L('muted', { name: name || watch.displayName?.(id) || id, n: minutes || '∞' }));
  return r.mute;
}
async function unmute(id) {
  const r = rec(id);
  r.mute = null;
  saveMod();
  await sendMute(id, false);
  notify(id, 'game.unmuted', {});
}

// ---------- Baneos temporales ----------
async function tempban(id, { minutes, reason = '', by, name = '' } = {}) {
  minutes = Math.max(1, parseInt(minutes, 10) || 60);
  const until = Date.now() + minutes * 60000;
  const r = rec(id);
  r.tempban = { since: Date.now(), until, by, reason };
  saveMod();
  const fullReason = tr(lang(), 'game.tempban_reason', { reason: reason || '—', until: new Date(until).toLocaleString(lang()) });
  await rcon.command(`banid ${id} ${q(name)} ${q(fullReason)}`);
  await rcon.command(`kick ${id} ${q(fullReason)}`).catch(() => {}); // banid no expulsa a quien ya está dentro
  await rcon.command('server.writecfg').catch(() => {});
  watch.markBanned(id, true);
  log('panel', L('tempbanned', { name: name || id, n: minutes }));
  return r.tempban;
}
function clearTempban(id) { if (mod[id]?.tempban) { mod[id].tempban = null; saveMod(); } }

async function permaban(id, reason, name = '') {
  await rcon.command(`banid ${id} ${q(name)} ${q(reason)}`);
  await rcon.command(`kick ${id} ${q(reason)}`).catch(() => {});
  await rcon.command('server.writecfg').catch(() => {});
  clearTempban(id);
  watch.markBanned(id, true);
}

// ---------- Advertencias ----------
function activeWarnings(id) {
  const exp = settings().policy.expireDays;
  const lim = Date.now() - exp * 86400000;
  return (mod[id]?.warnings || []).filter(w => !exp || w.t >= lim);
}

async function warn(id, { reason = '', by, name = '' } = {}) {
  reason = String(reason || '').trim().slice(0, 300);
  if (!reason) throw E('empty_reason');
  const w = { id: newId(), t: Date.now(), by, reason };
  rec(id).warnings.unshift(w);
  saveMod();
  const n = activeWarnings(id).length;
  notify(id, 'game.warned', { n, reason });
  // Sanción automática: el paso con el umbral más alto alcanzado exactamente ahora
  const step = [...settings().policy.steps].filter(s => s.action !== 'none' && s.at === n).pop();
  let applied = null;
  if (step) {
    const auto = tr(lang(), 'mod.autoReason', { n, reason });
    if (step.action === 'kick') await rcon.command(`kick ${id} ${q(auto)}`).catch(() => {});
    if (step.action === 'mute') await mute(id, { minutes: step.minutes, reason: auto, by: 'system', name });
    if (step.action === 'tempban') await tempban(id, { minutes: step.minutes, reason: auto, by: 'system', name });
    if (step.action === 'ban') await permaban(id, auto, name);
    applied = step;
  }
  log('panel', L('warned', { name: name || id, n }));
  return { warning: w, active: n, applied };
}
function deleteWarning(id, wid) {
  const r = rec(id); const before = r.warnings.length;
  r.warnings = r.warnings.filter(w => w.id !== wid);
  if (r.warnings.length === before) throw E('not_found');
  saveMod();
}

// Mensaje privado al jugador si el complemento está cargado
function notify(id, key, params) {
  if (!watch.isBridgeLoaded() || !rcon.isConnected()) return;
  rcon.command(`oxidian.pm ${id} ${b64(tr(lang(), key, params))}`).catch(() => {});
}

// ---------- Consultas ----------
function player(id) {
  const r = mod[id] || { notes: [], warnings: [], mute: null, tempban: null };
  const active = new Set(activeWarnings(id).map(w => w.id));
  return { ...r, warnings: r.warnings.map(w => ({ ...w, active: active.has(w.id) })), activeWarnings: active.size };
}
function summary() {
  const out = {};
  for (const [id, r] of Object.entries(mod)) {
    const w = activeWarnings(id).length;
    if (w || r.mute || r.tempban || r.notes.length) out[id] = { warnings: w, notes: r.notes.length, muted: !!r.mute, mutedUntil: r.mute?.until || null, tempbanUntil: r.tempban?.until || null };
  }
  return out;
}
function active() {
  return Object.entries(mod).filter(([, r]) => r.mute || r.tempban).map(([id, r]) => ({
    steamid: id, name: watch.displayName ? watch.displayName(id) : id, mute: r.mute, tempban: r.tempban,
  }));
}

// ---------- Ajustes ----------
function updateFilter(v) {
  const words = [...new Set(String(Array.isArray(v.words) ? v.words.join('\n') : v.words || '').split(/[\n,]+/).map(w => w.trim()).filter(Boolean))].slice(0, 500);
  const filter = {
    words, block: !!v.block,
    action: ['none', 'warn', 'mute', 'kick'].includes(v.action) ? v.action : 'none',
    muteMinutes: Math.min(10080, Math.max(1, parseInt(v.muteMinutes, 10) || 15)),
  };
  config.update('moderation', { ...settings(), filter });
  buildFilter();
  pushFilter();
  return filter;
}
function updatePolicy(v) {
  const steps = (Array.isArray(v.steps) ? v.steps : []).slice(0, 5).map(s => ({
    at: Math.min(50, Math.max(1, parseInt(s.at, 10) || 1)),
    action: ACTIONS.includes(s.action) ? s.action : 'none',
    minutes: Math.min(525600, Math.max(0, parseInt(s.minutes, 10) || 0)),
  })).filter(s => s.action !== 'none').sort((a, b) => a.at - b.at);
  const policy = { expireDays: Math.min(3650, Math.max(0, parseInt(v.expireDays, 10) || 0)), steps };
  config.update('moderation', { ...settings(), policy });
  return policy;
}

// ---------- Caducidad de silencios y baneos temporales ----------
async function tick() {
  if (!rcon.isConnected()) return;
  const now = Date.now();
  for (const [id, r] of Object.entries(mod)) {
    if (r.mute?.until && r.mute.until <= now) {
      r.mute = null; saveMod();
      await sendMute(id, false);
      log('panel', L('unmuted_auto', { name: watch.displayName ? watch.displayName(id) : id }));
    }
    if (r.tempban?.until && r.tempban.until <= now) {
      r.tempban = null; saveMod();
      await rcon.command(`unban ${id}`).catch(() => {});
      await rcon.command('server.writecfg').catch(() => {});
      watch.markBanned(id, false);
      log('panel', L('unbanned_auto', { name: watch.displayName ? watch.displayName(id) : id }));
    }
  }
}

// Al reconectar, vuelve a aplicar los silencios vigentes y el filtro (Rust no los recuerda tras reiniciar)
async function resync() {
  await pushFilter();
  for (const [id, r] of Object.entries(mod)) {
    if (r.mute) await sendMute(id, true, r.mute.until ? Math.round((r.mute.until - Date.now()) / 1000) : 0);
  }
}

function start() {
  bus.on('chat', (c) => onChat(c).catch(() => {}));
  bus.on('bridge', (ev) => { if (ev?.type === 'chatblock') onBlocked(ev).catch(() => {}); });
  bus.on('rcon', ({ connected }) => { if (connected) setTimeout(() => resync().catch(() => {}), 6000); });
  setInterval(() => tick().catch(() => {}), 30000);
}

module.exports = {
  start, listChat, pm, say, addNote, deleteNote, mute, unmute, tempban, clearTempban, warn, deleteWarning,
  player, summary, active, settings, updateFilter, updatePolicy, matchWord,
};
