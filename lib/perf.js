// Rendimiento: diagnóstico del arranque (fases medidas en el registro del servidor y consejos)
// y alertas de rendimiento (FPS bajos, RAM alta, servidor colgado) con reinicio automático opcional.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const server = require('./server');
const watch = require('./watch');
const { bus, log } = require('./bus');
const { E, L, tr, errParam } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'perf.json');
const DEFAULTS = {
  enabled: true,
  fpsMin: 15, fpsMinutes: 5,        // FPS por debajo de fpsMin durante fpsMinutes
  ramPct: 92,                       // RAM del servidor sobre la memoria total del equipo
  hangMinutes: 3,                   // proceso vivo pero sin responder por RCON
  autoRestartHang: true, autoRestartFps: false,
  discord: true,
};

// Fases del arranque reconocidas en el registro (Rust, Oxide y Carbon). La primera línea que coincide marca su inicio.
const PHASES = [
  ['assets', /Asset ?Warmup|Prefab ?Warmup|Loading Prefab|Loading Bundle|Bundles? loaded|GameManifest|Loading content/i],
  ['world', /Loading world|Generating|World ?generation|Loading Terrain|Loading save|Loading .*\.(map|sav)\b|Spawning \d+ |Spawn ?Handler/i],
  ['mapupload', /\[Rust\.MapCache\]/i],
  ['plugins', /Loading Oxide|Oxide\.(Core|Rust)|\[Carbon\]|Carbon\.|Loaded plugin|Loading plugins/i],
  ['ready', /Server startup complete|SteamServer Initialized/i],
];

let db = { boots: [], events: [] };
let boot = null;          // arranque en curso
let lastOk = Date.now();  // última respuesta correcta por RCON
let lowFpsSince = null, ramHigh = false, fpsAlerted = false, hangAlerted = false, restarting = false;

function load() { try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { fs.writeFileSync(FILE, JSON.stringify(db)); }
const settings = () => ({ ...DEFAULTS, ...(config.get().perf || {}) });
const lang = () => config.get().panel.notifyLang || 'es';

// ---------- Diagnóstico de arranque ----------
function beginBoot() {
  const s = config.get().server;
  boot = {
    t: Date.now(), marks: {}, lines: 0, plugins: 0, pluginErrors: 0, slowPlugins: [],
    mapUploadFailed: 0, mapUploaded: false, generated: false,
    worldsize: s.worldsize, level: s.level, framework: s.framework,
    freeRamMB: Math.round(os.freemem() / 1048576), totalRamMB: Math.round(os.totalmem() / 1048576),
    highPriority: !!s.highPriority, platform: process.platform,
  };
}

function onLine(line) {
  if (!boot || boot.done) return;
  const now = Date.now();
  boot.lines++;
  for (const [name, re] of PHASES) if (!boot.marks[name] && re.test(line)) boot.marks[name] = now;
  if (/Generating|World ?generation/i.test(line)) boot.generated = true;
  if (/Failed to upload map file/i.test(line)) boot.mapUploadFailed++;
  if (/Map uploaded to backend/i.test(line)) boot.mapUploaded = true;
  if (/Loaded plugin/i.test(line)) {
    boot.plugins++;
    const m = /Loaded plugin\s+(.+?)\s+v[\d.]+.*?\[(\d+(?:\.\d+)?)\s*ms\]/i.exec(line);
    if (m && +m[2] >= 300) { boot.slowPlugins.push({ name: m[1], ms: Math.round(+m[2]) }); boot.slowPlugins.sort((a, b) => b.ms - a.ms); boot.slowPlugins = boot.slowPlugins.slice(0, 8); }
  }
  if (/Error while compiling|Failed to (load|compile) plugin|Failed compiling/i.test(line)) boot.pluginErrors++;
  if (boot.marks.ready) finishBoot(true);
}

function phasesOf(b) {
  const end = b.marks.ready || b.end || Date.now();
  const pts = Object.entries(b.marks).filter(([k]) => k !== 'ready').sort((x, y) => x[1] - y[1]);
  const out = [];
  let from = b.t, name = 'process';
  for (const [k, at] of pts) { if (at > from) out.push({ name, ms: at - from }); from = at; name = k; }
  if (end > from) out.push({ name, ms: end - from });
  return out;
}

function advice(b) {
  const out = [], ph = Object.fromEntries(phasesOf(b).map(p => [p.name, p.ms]));
  const total = (b.marks.ready || b.end || Date.now()) - b.t;
  if (b.mapUploadFailed) out.push({ code: 'mapupload', sev: 'medium', p: { n: b.mapUploadFailed } });
  if (b.platform === 'win32' && (ph.assets || 0) > 150000) out.push({ code: 'antivirus', sev: 'medium', p: { s: Math.round(ph.assets / 1000) } });
  else if ((ph.assets || 0) > 240000) out.push({ code: 'disk', sev: 'medium', p: { s: Math.round(ph.assets / 1000) } });
  if (b.generated || (ph.world || 0) > 90000) out.push({ code: 'mapgen', sev: 'low', p: { s: Math.round((ph.world || 0) / 1000), size: b.worldsize } });
  if (b.worldsize > 4500) out.push({ code: 'bigmap', sev: 'low', p: { size: b.worldsize } });
  if (b.pluginErrors) out.push({ code: 'pluginerr', sev: 'medium', p: { n: b.pluginErrors } });
  if (b.plugins > 40 || (ph.plugins || 0) > 60000) out.push({ code: 'plugins', sev: 'low', p: { n: b.plugins, s: Math.round((ph.plugins || 0) / 1000) } });
  if (b.freeRamMB && b.freeRamMB < 8192) out.push({ code: 'ram', sev: b.freeRamMB < 6144 ? 'high' : 'medium', p: { gb: Math.round(b.freeRamMB / 102.4) / 10 } });
  if (!b.highPriority) out.push({ code: 'priority', sev: 'low', p: {} });
  if (total > 600000 && !out.some(a => ['antivirus', 'disk', 'mapgen', 'ram'].includes(a.code))) out.push({ code: 'slow', sev: 'medium', p: { m: Math.round(total / 60000) } });
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b2) => rank[a.sev] - rank[b2.sev]);
}

function summary(b) {
  if (!b) return null;
  const end = b.marks.ready || b.end || null;
  return {
    t: b.t, done: !!b.done, ok: !!b.marks.ready, total: (end || Date.now()) - b.t, phases: phasesOf(b), advice: advice(b),
    plugins: b.plugins, pluginErrors: b.pluginErrors, slowPlugins: b.slowPlugins, mapUploadFailed: b.mapUploadFailed, mapUploaded: b.mapUploaded,
    generated: b.generated, worldsize: b.worldsize, framework: b.framework, freeRamMB: b.freeRamMB, totalRamMB: b.totalRamMB, highPriority: b.highPriority,
  };
}

function finishBoot(ok) {
  if (!boot || boot.done) return;
  boot.done = true; boot.end = Date.now();
  const s = summary(boot);
  db.boots.push(s); db.boots = db.boots.slice(-30); save();
  if (ok) log('panel', L('boot_done', { s: Math.round(s.total / 1000) }));
}

// ---------- Prioridad del proceso ----------
function applyPriority(pid) {
  if (!pid || !config.get().server.highPriority) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
    log('panel', L('priority_set'));
  } catch (e) {
    // En Linux subir la prioridad necesita permisos de administrador
    try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); log('panel', L('priority_set_partial')); }
    catch { log('panel', L('priority_failed', { error: errParam(e) })); }
  }
}

// ---------- Alertas de rendimiento ----------
async function discord(title, description, color) {
  const hook = watch.discordWebhook ? watch.discordWebhook() : '';
  if (!settings().discord || !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook || '')) return;
  await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Scrapwarden', embeds: [{ title, description, color, timestamp: new Date().toISOString(), footer: { text: config.get().server.hostname } }] }) }).catch(() => {});
}

function event(code, p = {}, sev = 'medium') {
  const ev = { t: Date.now(), code, p, sev };
  db.events.push(ev); db.events = db.events.slice(-100); save();
  log('panel', L('perf_' + code, p));
  bus.emit('perf', ev);
  discord(tr(lang(), `pf.ev.${code}.title`, p), tr(lang(), `pf.ev.${code}.detail`, p), sev === 'high' ? 0xD0682F : 0xE0A93B);
}

async function restartNow(code) {
  if (restarting) return;
  restarting = true;
  try {
    event('restart_' + code, {}, 'high');
    if (code === 'hang') { server.kill(); await new Promise(r => setTimeout(r, 4000)); server.start(); }
    else { await server.restart(); }
  } catch (e) { log('panel', L('perf_restart_failed', { error: errParam(e) })); }
  finally { setTimeout(() => { restarting = false; }, 60000); }
}

async function tick() {
  const s = settings();
  const st = server.getStatus().status;
  if (st !== 'running' || restarting) { lowFpsSince = null; lastOk = Date.now(); hangAlerted = false; return; }
  let info = null;
  if (rcon.isConnected()) info = await rcon.json('serverinfo', 15000).catch(() => null);
  if (info) { lastOk = Date.now(); hangAlerted = false; }
  if (!s.enabled) return;

  // Servidor colgado: el proceso sigue vivo pero no responde (solo si el proceso es del panel)
  const silentMin = (Date.now() - lastOk) / 60000;
  if (server.isManaged() && silentMin >= s.hangMinutes && !hangAlerted) {
    hangAlerted = true;
    event('hang', { m: Math.round(silentMin) }, 'high');
    if (s.autoRestartHang) restartNow('hang');
    return;
  }
  if (!info) return;

  // FPS bajos sostenidos
  const fps = Math.round(info.Framerate || 0);
  if (fps && fps < s.fpsMin) {
    lowFpsSince ||= Date.now();
    if (!fpsAlerted && Date.now() - lowFpsSince >= s.fpsMinutes * 60000) {
      fpsAlerted = true;
      event('fps', { fps, min: s.fpsMin, m: s.fpsMinutes, players: info.Players | 0, ents: info.EntityCount | 0 }, 'high');
      if (s.autoRestartFps) restartNow('fps');
    }
  } else if (fps >= s.fpsMin) {
    if (fpsAlerted) event('fps_ok', { fps }, 'low');
    lowFpsSince = null; fpsAlerted = false;
  }

  // RAM del servidor sobre el total del equipo
  const ramMB = server.resources()?.ramMB || 0, totalMB = os.totalmem() / 1048576;
  const pct = totalMB ? Math.round(ramMB / totalMB * 100) : 0;
  if (pct >= s.ramPct && !ramHigh) { ramHigh = true; event('ram', { pct, gb: Math.round(ramMB / 102.4) / 10 }, 'medium'); }
  else if (pct < s.ramPct - 5) ramHigh = false;
}

// ---------- API ----------
function view() {
  const st = server.getStatus();
  return {
    settings: settings(),
    highPriority: !!config.get().server.highPriority,
    current: summary(boot),
    boots: db.boots.slice(-15).reverse(),
    events: db.events.slice(-30).reverse(),
    status: st.status,
    sys: { totalRamGB: Math.round(os.totalmem() / 107374182.4) / 10, freeRamGB: Math.round(os.freemem() / 107374182.4) / 10, cpus: os.cpus().length, cpu: os.cpus()[0]?.model || '', platform: process.platform },
    server: { worldsize: config.get().server.worldsize, framework: config.get().server.framework },
  };
}

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
  if (input.fpsMin !== undefined) out.fpsMin = num(input.fpsMin, 1, 200);
  if (input.fpsMinutes !== undefined) out.fpsMinutes = num(input.fpsMinutes, 1, 60);
  if (input.ramPct !== undefined) out.ramPct = num(input.ramPct, 50, 99);
  if (input.hangMinutes !== undefined) out.hangMinutes = num(input.hangMinutes, 1, 30);
  for (const k of ['enabled', 'autoRestartHang', 'autoRestartFps', 'discord']) if (input[k] !== undefined) out[k] = !!input[k];
  config.update('perf', out);
  if (input.highPriority !== undefined) {
    config.update('server', { highPriority: !!input.highPriority });
    if (input.highPriority && server.getStatus().pid) applyPriority(server.getStatus().pid);
  }
  return view();
}

function start() {
  load();
  bus.on('status', (s) => {
    if (s.status === 'starting' && (!boot || boot.done || boot.t < (s.startedAt || 0))) { beginBoot(); setTimeout(() => applyPriority(s.pid), 1500); }
    if (s.status === 'stopped' && boot && !boot.done) finishBoot(false);
  });
  bus.on('console', (e) => { if (e.source === 'server') onLine(e.line || ''); });
  setInterval(() => tick().catch(() => {}), 30000);
}

module.exports = { start, view, update, _phasesOf: phasesOf };
