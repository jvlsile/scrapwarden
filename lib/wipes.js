// Planificador de wipes: wipe forzado de Facepunch (primer jueves de cada mes, 19:00 en Londres),
// calendarios semanal o quincenal, avisos en el juego y en Discord, y wipe automático completo.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const server = require('./server');
const installer = require('./installer');
const maint = require('./maintenance');
const stats = require('./stats');
const watch = require('./watch');
const { log } = require('./bus');
const { E, L, errParam, tr } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'wipes.json');
const DEFAULTS = {
  enabled: false,
  schedule: 'forced',   // forced | weekly | biweekly
  weekday: 4,           // 0 = domingo … 6 = sábado (hora local del panel)
  time: '19:00',
  anchor: null,         // para el quincenal: fecha de referencia de un wipe
  bp: 'forced',         // forced (planos solo en el forzado) | always | never
  newSeed: true,
  backup: true,
  update: true,         // actualizar servidor y Oxide/Carbon antes del wipe forzado
  forcedDelay: 30,      // minutos tras la hora oficial (da tiempo a que salga la actualización de Oxide/Carbon)
  announce: true,       // avisos en el chat: 24 h, 1 h y los últimos minutos
  discord: true,        // aviso en Discord 24 h antes y al terminar
};
const SCHEDULES = ['forced', 'weekly', 'biweekly'];
const BP = ['forced', 'always', 'never'];
const WARN_MIN = [30, 15, 10, 5, 3, 2, 1];

let state = { history: [], done: [], warned: [], skipped: [] };
let busy = false;

function load() { try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
const settings = () => ({ ...DEFAULTS, ...(config.get().wipes || {}) });

// ---------- Fechas ----------
// Diferencia (minutos) entre la hora de una zona y UTC en un instante dado
function tzOffset(tz, t) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(t)).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute) - Math.floor(t / 60000) * 60000) / 60000;
}
function zonedToUtc(tz, y, m, d, h, mi) {
  let guess = Date.UTC(y, m, d, h, mi);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m, d, h, mi) - tzOffset(tz, guess) * 60000;
  return guess;
}
// Wipe forzado de un mes: primer jueves a las 19:00 (Europa/Londres)
function forcedFor(y, m) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const day = 1 + ((4 - first + 7) % 7);
  return zonedToUtc('Europe/London', y, m, day, 19, 0);
}
function nextForced(from = Date.now(), count = 3) {
  const out = [], d = new Date(from);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  while (out.length < count) {
    const t = forcedFor(y, m);
    if (t > from - 6 * 3600e3) out.push(t);
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

function customDates(s, from, until) {
  if (s.schedule === 'forced') return [];
  const [hh, mm] = (s.time || '19:00').split(':').map(Number);
  const out = [];
  const d = new Date(from); d.setHours(hh, mm, 0, 0);
  while (d.getDay() !== Number(s.weekday)) d.setDate(d.getDate() + 1);
  const anchor = s.anchor ? new Date(s.anchor) : null;
  for (let t = d.getTime(); t < until; ) {
    let ok = true;
    if (s.schedule === 'biweekly' && anchor) {
      const weeks = Math.round((t - anchor.getTime()) / (7 * 864e5));
      ok = weeks % 2 === 0;
    }
    if (ok && t > from - 6 * 3600e3) out.push(t);
    const n = new Date(t); n.setDate(n.getDate() + 7); t = n.getTime();
  }
  return out;
}

// Próximos wipes (combinando el forzado con el calendario propio)
function upcoming(count = 6, from = Date.now()) {
  const s = settings();
  const until = from + 120 * 864e5;
  const forced = nextForced(from, 5).map(t => ({ at: t + (s.forcedDelay || 0) * 60000, official: t, forced: true }));
  // En la semana del forzado no se hace el wipe propio (como hacen casi todos los servidores)
  const custom = customDates(s, from, until)
    .filter(t => !forced.some(f => Math.abs(f.official - t) < 3.5 * 864e5))
    .map(t => ({ at: t, forced: false }));
  return [...forced, ...custom]
    .filter(w => w.at > from - 2 * 3600e3)
    .sort((a, b) => a.at - b.at)
    .map(w => ({ ...w, key: (w.forced ? 'F' : 'C') + w.at, bp: s.bp === 'always' || (s.bp === 'forced' && w.forced) }))
    .filter(w => !state.done.includes(w.key) && !state.skipped.includes(w.key))
    .slice(0, count);
}

function next() { return settings().enabled ? upcoming(1)[0] || null : null; }

function view() {
  const s = settings();
  return {
    settings: s,
    upcoming: upcoming(6),
    forced: nextForced(Date.now(), 3),
    history: state.history.slice(-20).reverse(),
    busy,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  if (SCHEDULES.includes(input.schedule)) out.schedule = input.schedule;
  if (input.weekday !== undefined) { const w = Number(input.weekday); if (w >= 0 && w <= 6) out.weekday = w; }
  if (input.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw E('bad_time'); out.time = input.time; }
  if (BP.includes(input.bp)) out.bp = input.bp;
  for (const k of ['newSeed', 'backup', 'update', 'announce', 'discord']) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.forcedDelay !== undefined) out.forcedDelay = Math.min(240, Math.max(0, Math.round(Number(input.forcedDelay) || 0)));
  // El quincenal cuenta desde el siguiente wipe que salga con la configuración nueva
  if (out.schedule === 'biweekly' && (input.anchor === 'reset' || !cur.anchor || cur.schedule !== 'biweekly' || cur.weekday !== out.weekday || cur.time !== out.time)) {
    const d = customDates({ ...out, schedule: 'weekly' }, Date.now(), Date.now() + 8 * 864e5)[0];
    out.anchor = d || Date.now();
  }
  config.update('wipes', out);
  return view();
}

function skip(key) {
  if (!upcoming(10).some(w => w.key === key)) throw E('wipe_not_found');
  state.skipped.push(key); state.skipped = state.skipped.slice(-50); save();
  log('panel', L('wipe_skipped'));
  return view();
}

// ---------- Avisos ----------
const lang = () => config.get().panel.notifyLang || 'es';
const say = (key, p) => rcon.isConnected() ? rcon.say(tr(lang(), key, p)).catch(() => {}) : null;

async function discord(title, description, color = 0x5BB5A2) {
  const hook = watch.discordWebhook ? watch.discordWebhook() : '';
  if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook || '')) return;
  await fetch(hook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Scrapwarden', embeds: [{ title, description, color, timestamp: new Date().toISOString(), footer: { text: config.get().server.hostname } }] }),
  }).catch(() => {});
}
const fmtWhen = (t) => new Date(t).toLocaleString(lang() === 'en' ? 'en-GB' : lang(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function warnOnce(key) {
  if (state.warned.includes(key)) return false;
  state.warned.push(key); state.warned = state.warned.slice(-100); save();
  return true;
}

// ---------- Ejecución ----------
async function execute(w, { manual = false } = {}) {
  if (config.isRemote()) throw E('remote_no_files');
  if (busy) throw E('wipe_busy');
  busy = true;
  const s = settings();
  const rec = { t: Date.now(), at: w?.at || Date.now(), forced: !!w?.forced, bp: !!w?.bp, manual, ok: false };
  try {
    log('panel', L(w?.forced ? 'wipe_auto_forced' : 'wipe_auto_start'));
    const wasRunning = server.isRunning();
    if (wasRunning) { if (rcon.isConnected()) await rcon.command('server.save', 30000).catch(() => {}); await server.stop(); }
    if (s.update && (w?.forced || manual)) {
      await installer.installServer({ validate: false }).catch(e => log('panel', L('update_failed', { error: errParam(e) })));
      const fw = config.get().server.framework;
      if (fw && fw !== 'none') await installer.installFramework(fw).catch(e => log('panel', L('update_failed', { error: errParam(e) })));
    }
    const r = await maint.wipe({ blueprints: !!w?.bp, newSeed: s.newSeed, backup: s.backup });
    stats.markWipe();
    rec.seed = r.seed; rec.removed = r.removed.length;
    server.start();
    rec.ok = true;
    log('panel', L('wipe_auto_done', { seed: r.seed }));
    if (s.discord) await discord(tr(lang(), 'wd2.discordDoneTitle'), tr(lang(), rec.bp ? 'wd2.discordDoneBp' : 'wd2.discordDone', { seed: r.seed, size: config.get().server.worldsize }));
  } catch (e) {
    rec.error = e.message;
    log('panel', L('wipe_auto_failed', { error: errParam(e) }));
    if (s.discord) await discord(tr(lang(), 'wd2.discordFailTitle'), e.message, 0xD0682F);
  } finally {
    busy = false;
    if (w?.key) state.done.push(w.key);
    state.done = state.done.slice(-100);
    state.history.push(rec); state.history = state.history.slice(-50);
    save();
  }
  return rec;
}

// Para el wipe manual desde Copias y wipe: lo deja en el historial y reinicia las estadísticas del wipe
function recordManual(result, blueprints) {
  stats.markWipe();
  state.history.push({ t: Date.now(), at: Date.now(), manual: true, ok: true, bp: !!blueprints, seed: result?.seed, removed: result?.removed?.length || 0 });
  state.history = state.history.slice(-50); save();
}

async function tick() {
  const s = settings();
  if (!s.enabled || busy || config.isRemote()) return; // en remoto el wipe lo hace el hosting
  const w = upcoming(1)[0];
  if (!w) return;
  const left = w.at - Date.now();
  const mins = Math.ceil(left / 60000);
  if (left <= 0) {
    if (left < -2 * 3600e3) { state.skipped.push(w.key); save(); log('panel', L('wipe_missed')); return; }
    if (s.announce) say('game.wipe_now');
    await execute(w);
    return;
  }
  if (s.announce && rcon.isConnected()) {
    if (left <= 24 * 3600e3 && left > 23 * 3600e3 && warnOnce(w.key + ':24h')) say('game.wipe_in_hours', { n: 24 });
    if (left <= 3600e3 && left > 50 * 60000 && warnOnce(w.key + ':1h')) say('game.wipe_in_1h');
    for (const m of WARN_MIN) if (mins === m && warnOnce(w.key + ':' + m)) say(m > 1 ? 'game.wipe_in_minutes' : 'game.wipe_in_1', { n: m });
  }
  if (s.discord && left <= 24 * 3600e3 && left > 23 * 3600e3 && warnOnce(w.key + ':d24')) {
    await discord(tr(lang(), 'wd2.discordSoonTitle'), tr(lang(), w.bp ? 'wd2.discordSoonBp' : 'wd2.discordSoon', { when: fmtWhen(w.at) }), 0xE0A93B);
  }
}

function start() {
  load();
  setInterval(() => tick().catch(e => log('panel', L('wipe_auto_failed', { error: errParam(e) }))), 30000);
}

module.exports = { start, view, update, skip, next, execute, recordManual, upcoming, nextForced, forcedFor, _tzOffset: tzOffset };
