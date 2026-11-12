// Estadísticas e historial: jugadores conectados, rendimiento, tiempo jugado, bajas y actividad por hora
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const server = require('./server');
const { bus } = require('./bus');

const FILE = path.join(config.DATA_DIR, 'stats.json');
const SAMPLE_MS = 5 * 60 * 1000;   // una muestra de rendimiento cada 5 min
const TICK_MS = 60 * 1000;         // tiempo jugado: cada minuto
const KEEP_SAMPLES_MS = 90 * 864e5;
const KEEP_DAYS = 120;

// samples: [t, jugadores, cola, fps, entidades, cpu, ramMB]
// days: { 'AAAA-MM-DD': { p: {id: segundos}, k: {id: bajas}, x: {id: muertes}, h: {id: a la cabeza} } }
// players: { id: { n: nombre, f: primera vez, l: última vez, s: sesiones } }
let db = { samples: [], days: {}, players: {}, wipeStart: null };
let online = new Set();
let lastTick = 0, lastSample = 0, dirty = false;

function load() {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
}
function save() {
  if (!dirty) return;
  dirty = false;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayStart = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const day = (t) => (db.days[dayKey(t)] ||= { p: {}, k: {}, x: {}, h: {} });
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

async function tickPlayers() {
  const now = Date.now();
  if (!rcon.isConnected()) { online = new Set(); lastTick = now; return; }
  let list;
  try { list = await rcon.json('playerlist'); } catch { return; }
  if (!Array.isArray(list)) return;
  const elapsed = lastTick ? Math.min(150, Math.max(0, Math.round((now - lastTick) / 1000))) : 60;
  lastTick = now;
  const next = new Set();
  const d = day(now);
  for (const p of list) {
    const id = String(p.SteamID || '');
    if (!/^\d{17}$/.test(id)) continue;
    next.add(id);
    const rec = (db.players[id] ||= { n: '', f: now, l: now, s: 0 });
    rec.n = p.DisplayName || rec.n;
    rec.l = now;
    if (!online.has(id)) rec.s++;
    if (online.has(id)) inc(d.p, id, elapsed);
    else d.p[id] = d.p[id] || 0; // cuenta como visto hoy
  }
  online = next;
  dirty = true;
}

async function sample() {
  const now = Date.now();
  if (!rcon.isConnected()) return;
  const info = await rcon.json('serverinfo').catch(() => null);
  if (!info) return;
  const res = server.resources() || {};
  db.samples.push([now, info.Players | 0, info.Queued | 0, Math.round(info.Framerate || 0), info.EntityCount | 0, Math.round(res.cpu || 0), Math.round(res.ramMB || info.Memory || 0)]);
  dirty = true;
}

function prune() {
  const lim = Date.now() - KEEP_SAMPLES_MS;
  while (db.samples.length && db.samples[0][0] < lim) db.samples.shift();
  const keys = Object.keys(db.days).sort();
  while (keys.length > KEEP_DAYS) delete db.days[keys.shift()];
}

function onBridge(ev) {
  if (ev?.type !== 'kill' || !ev.steamid || !ev.victim) return;
  const d = day(ev.t || Date.now());
  inc(d.k, ev.steamid);
  inc(d.x, ev.victim);
  if (ev.headshot) inc(d.h, ev.steamid);
  for (const [id, n] of [[ev.steamid, ev.name], [ev.victim, ev.victimName]]) {
    const rec = (db.players[id] ||= { n: '', f: Date.now(), l: Date.now(), s: 0 });
    if (n) rec.n = n;
  }
  dirty = true;
}

function markWipe(t = Date.now()) { db.wipeStart = t; dirty = true; save(); }

// ---------- Consultas ----------
const RANGES = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };

function rangeFrom(range) {
  if (range === 'wipe') return db.wipeStart || (Date.now() - 30 * 864e5);
  return Date.now() - (RANGES[range] || RANGES['7d']);
}

function downsample(rows, from, max = 240) {
  const r = rows.filter(s => s[0] >= from);
  if (r.length <= max) return r.map(s => [s[0], s[1], s[1], s[3], s[4], s[6], s[2]]);
  const span = (Date.now() - from) / max, out = [];
  let b = null;
  for (const s of r) {
    const idx = Math.floor((s[0] - from) / span);
    if (!b || b.i !== idx) { if (b) out.push(b); b = { i: idx, t: s[0], n: 0, p: 0, pm: 0, f: 0, e: 0, m: 0, q: 0 }; }
    b.n++; b.p += s[1]; b.pm = Math.max(b.pm, s[1]); b.f += s[3]; b.e += s[4]; b.m += s[6]; b.q = Math.max(b.q, s[2]);
  }
  if (b) out.push(b);
  // [t, media de jugadores, pico, fps, entidades, ram, cola]
  return out.map(b => [b.t, Math.round(b.p / b.n * 10) / 10, b.pm, Math.round(b.f / b.n), Math.round(b.e / b.n), Math.round(b.m / b.n), b.q]);
}

function query(range = '7d') {
  const now = Date.now(), from = rangeFrom(range);
  const inRange = db.samples.filter(s => s[0] >= from);
  // Días que tocan el periodo (el primero puede ser parcial)
  const dayKeys = Object.keys(db.days).filter(k => dayStart(k) + 864e5 > from).sort();
  const play = {}, kills = {}, deaths = {}, heads = {};
  for (const k of dayKeys) {
    const d = db.days[k];
    for (const [id, s] of Object.entries(d.p || {})) inc(play, id, s);
    for (const [id, n] of Object.entries(d.k || {})) inc(kills, id, n);
    for (const [id, n] of Object.entries(d.x || {})) inc(deaths, id, n);
    for (const [id, n] of Object.entries(d.h || {})) inc(heads, id, n);
  }
  const uniques = Object.keys(play).filter(id => range !== '24h' || (db.players[id]?.l || 0) >= from);
  const newcomers = uniques.filter(id => (db.players[id]?.f || 0) >= from);
  const totalSecs = Object.values(play).reduce((a, b) => a + b, 0);
  let peak = { n: 0, t: null };
  for (const s of inRange) if (s[1] > peak.n) peak = { n: s[1], t: s[0] };
  const avg = inRange.length ? inRange.reduce((a, s) => a + s[1], 0) / inRange.length : 0;
  const fpsAvg = inRange.length ? inRange.reduce((a, s) => a + s[3], 0) / inRange.length : 0;
  const fpsMin = inRange.length ? Math.min(...inRange.map(s => s[3])) : 0;

  // Mapa de calor: media de jugadores por día de la semana y hora (últimas 4 semanas como mínimo)
  const hmFrom = Math.min(from, now - 28 * 864e5);
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0)), cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of db.samples) {
    if (s[0] < hmFrom) continue;
    const d = new Date(s[0]), wd = (d.getDay() + 6) % 7; // lunes = 0
    sum[wd][d.getHours()] += s[1]; cnt[wd][d.getHours()]++;
  }
  const heatmap = sum.map((row, i) => row.map((v, h) => cnt[i][h] ? Math.round(v / cnt[i][h] * 10) / 10 : null));

  // Actividad diaria
  const dailyKeys = (range === '24h' || range === '7d') ? lastDays(14) : dayKeys;
  const daily = dailyKeys.map(k => {
    const d = db.days[k] || { p: {} };
    const ids = Object.keys(d.p || {});
    const ds = dayStart(k);
    return { d: k, u: ids.length, n: ids.filter(id => { const f = db.players[id]?.f || 0; return f >= ds && f < ds + 864e5; }).length, h: Math.round(Object.values(d.p || {}).reduce((a, b) => a + b, 0) / 360) / 10 };
  });

  const name = (id) => db.players[id]?.n || id;
  const topPlay = Object.entries(play).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, s]) => ({ id, name: name(id), hours: Math.round(s / 360) / 10, sessions: db.players[id]?.s || 0, first: db.players[id]?.f || null, online: online.has(id) }));
  const topKills = Object.entries(kills).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, k]) => ({ id, name: name(id), kills: k, deaths: deaths[id] || 0, kd: Math.round(k / Math.max(1, deaths[id] || 0) * 100) / 100, hs: Math.round((heads[id] || 0) / k * 100) }));

  return {
    range, from, now, wipeStart: db.wipeStart,
    online: online.size,
    summary: {
      peak, avg: Math.round(avg * 10) / 10, uniques: uniques.length, newcomers: newcomers.length,
      returning: uniques.length ? Math.round((uniques.length - newcomers.length) / uniques.length * 100) : 0,
      hours: Math.round(totalSecs / 360) / 10, fpsAvg: Math.round(fpsAvg), fpsMin,
      kills: Object.values(kills).reduce((a, b) => a + b, 0),
    },
    series: downsample(db.samples, from),
    heatmap, daily, topPlay, topKills,
    samples: inRange.length,
  };
}

function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(Date.now() - i * 864e5));
  return out;
}

function start() {
  load();
  bus.on('bridge', onBridge);
  setInterval(() => tickPlayers().catch(() => {}), TICK_MS);
  setInterval(async () => {
    if (Date.now() - lastSample >= SAMPLE_MS - 5000) { lastSample = Date.now(); await sample().catch(() => {}); prune(); save(); }
  }, 30 * 1000);
  setTimeout(() => sample().catch(() => {}), 20000);
  // Guarda al cerrar (el panel ya gestiona SIGINT/SIGTERM y termina con process.exit)
  process.on('exit', () => { try { save(); } catch {} });
}

module.exports = { start, query, markWipe, _db: () => db, _save: save };
