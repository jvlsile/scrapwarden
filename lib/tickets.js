// Tickets de reportes F7: cada reporte del juego abre un ticket (o se suma al abierto del mismo jugador),
// con asignación, comentarios del staff y cierre con sanción; al cerrar se puede avisar a quien reportó.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const watch = require('./watch');
const moderation = require('./moderation');
const { bus, log } = require('./bus');
const { E, L, tr } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'tickets.json');
const RESOLUTIONS = ['none', 'warn', 'mute', 'kick', 'tempban', 'ban'];
let db = { seq: 0, tickets: [] };

function load() { try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { db.tickets = db.tickets.slice(-2000); fs.writeFileSync(FILE, JSON.stringify(db)); }
const lang = () => config.get().panel.notifyLang || 'es';
const now = () => Date.now();
const find = (id) => { const t = db.tickets.find(x => x.id === Number(id)); if (!t) throw E('ticket_not_found'); return t; };
const counts = () => ({ open: db.tickets.filter(t => t.status === 'open').length, progress: db.tickets.filter(t => t.status === 'progress').length });
const emit = () => bus.emit('tickets', counts());

// ---------- Reportes que llegan del juego ----------
function onReport(ev) {
  const id = String(ev.steamid || '');
  if (!/^\d{17}$/.test(id)) return;
  const r = { t: ev.t || now(), reporter: String(ev.reporter || ''), reporterName: String(ev.reporterName || ''), subject: String(ev.subject || '').slice(0, 200), message: String(ev.message || '').slice(0, 1000), kind: String(ev.kind || '') };
  let tk = db.tickets.find(t => t.target.id === id && t.status !== 'closed');
  if (tk) {
    // El mismo jugador no cuenta dos veces el mismo reporte (Rust permite repetirlo)
    if (tk.reports.some(x => x.reporter === r.reporter && x.subject === r.subject && r.t - x.t < 60000)) return;
    tk.reports.push(r); tk.updated = r.t;
  } else {
    tk = { id: ++db.seq, status: 'open', target: { id, name: String(ev.name || id) }, reports: [r], assignee: null, comments: [], created: r.t, updated: r.t, closed: null };
    db.tickets.push(tk);
    log('panel', L('ticket_new', { n: tk.id, name: tk.target.name }));
  }
  save(); emit();
}

// ---------- Consultas ----------
function summary(t) {
  const reporters = new Set(t.reports.map(r => r.reporter)).size;
  return {
    id: t.id, status: t.status, target: t.target, assignee: t.assignee, created: t.created, updated: t.updated,
    reports: t.reports.length, reporters, lastSubject: t.reports[t.reports.length - 1]?.subject || '',
    kinds: [...new Set(t.reports.map(r => r.kind).filter(Boolean))], comments: t.comments.length,
    closed: t.closed ? { t: t.closed.t, by: t.closed.by, resolution: t.closed.resolution } : null,
  };
}
function list(status = 'active') {
  let items = db.tickets;
  if (status === 'active') items = items.filter(t => t.status !== 'closed');
  else if (['open', 'progress', 'closed'].includes(status)) items = items.filter(t => t.status === status);
  // Primero los que más jugadores distintos reportan, luego los más recientes
  return { items: items.map(summary).sort((a, b) => (status === 'closed' ? b.closed.t - a.closed.t : (b.reporters - a.reporters) || (b.updated - a.updated))).slice(0, 300), counts: counts() };
}
function get(id) {
  const t = find(id);
  const info = watch.playerInfo ? watch.playerInfo(t.target.id) : null;
  return { ...t, player: info ? { totals: info.totals || {}, names: info.names || [], banned: !!info.banned, alerts: (info.alerts || []).slice(0, 5).map(a => ({ t: a.t, code: a.code, params: a.params, severity: a.severity })) } : null, mod: moderation.player ? moderation.player(t.target.id) : null };
}

// ---------- Acciones del staff ----------
function assign(id, user, to) {
  const t = find(id);
  if (t.status === 'closed') throw E('ticket_closed');
  t.assignee = to === null ? null : user;
  if (t.assignee && t.status === 'open') t.status = 'progress';
  if (!t.assignee && t.status === 'progress') t.status = 'open';
  t.updated = now(); save(); emit();
  return get(id);
}
function comment(id, user, text) {
  const t = find(id);
  text = String(text || '').trim().slice(0, 2000);
  if (!text) throw E('empty_note');
  t.comments.push({ t: now(), by: user, text });
  t.updated = now(); save();
  return get(id);
}
function reopen(id, user) {
  const t = find(id);
  t.status = t.assignee ? 'progress' : 'open'; t.closed = null; t.updated = now();
  t.comments.push({ t: now(), by: user, text: '↺', system: 'reopened' });
  save(); emit();
  return get(id);
}

async function close(id, user, { resolution = 'none', minutes = 60, note = '', notify = true } = {}) {
  const t = find(id);
  if (t.status === 'closed') throw E('ticket_closed');
  if (!RESOLUTIONS.includes(resolution)) throw E('bad_action');
  const pid = t.target.id, name = t.target.name;
  const reason = String(note || '').trim().slice(0, 120) || tr(lang(), 'game.ticket_reason', { n: t.id });
  minutes = Math.max(1, Math.min(60 * 24 * 365, Math.round(Number(minutes) || 60)));
  // La sanción usa las mismas funciones que la moderación normal (quedan en la ficha del jugador)
  if (resolution === 'warn') await moderation.warn(pid, { reason, by: user, name });
  if (resolution === 'mute') await moderation.mute(pid, { minutes, reason, by: user, name });
  if (resolution === 'tempban') await moderation.tempban(pid, { minutes, reason, by: user, name });
  if (resolution === 'kick') await rcon.command(`kick ${pid} "${reason.replace(/"/g, "'")}"`);
  if (resolution === 'ban') {
    await rcon.command(`banid ${pid} "${String(name).replace(/"/g, "'")}" "${reason.replace(/"/g, "'")}"`);
    await rcon.command(`kick ${pid} "${reason.replace(/"/g, "'")}"`).catch(() => {});
    await rcon.command('server.writecfg').catch(() => {});
    watch.markBanned(pid, true);
  }
  t.status = 'closed';
  t.closed = { t: now(), by: user, resolution, note: String(note || '').slice(0, 500), minutes: ['mute', 'tempban'].includes(resolution) ? minutes : null };
  t.updated = now();
  save(); emit();
  log('panel', L('ticket_closed', { n: t.id, name, r: { k: 'tk.res.' + resolution } }));
  // Agradecer a quienes reportaron (solo a los conectados, por mensaje privado)
  let notified = 0;
  if (notify && rcon.isConnected() && watch.isBridgeLoaded()) {
    const key = resolution === 'none' ? 'game.report_reviewed' : 'game.report_actioned';
    for (const rid of new Set(t.reports.map(r => r.reporter).filter(x => /^\d{17}$/.test(x)))) {
      const msg = Buffer.from(tr(lang(), key, { name })).toString('base64');
      const ok = await watch.rconJson(`oxidian.pm ${rid} ${msg}`, 5000).then(() => true).catch(() => false);
      if (ok) notified++;
    }
  }
  return { ...get(id), notified };
}

function start() {
  load();
  bus.on('bridge', (ev) => { if (ev?.type === 'report') { try { onReport(ev); } catch {} } });
}

module.exports = { start, list, get, assign, comment, close, reopen, counts, RESOLUTIONS };
