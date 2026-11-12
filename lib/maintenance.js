// Copias de seguridad, wipes y tareas programadas (reinicios con aviso, anuncios)
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('./config');
const server = require('./server');
const rcon = require('./rcon');
const installer = require('./installer');
const { log } = require('./bus');
const { E, L, errParam, tr } = require('./i18n');
const say = (key, params) => rcon.say(tr(config.get().panel.notifyLang || 'es', key, params)).catch(() => {});

// ---------- Copias de seguridad ----------
function backupDir() {
  const d = config.get().paths.backups;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function createBackup(label = 'manual') {
  const p = config.serverPaths();
  if (server.isRunning() && rcon.isConnected()) {
    await rcon.command('server.save', 60000).catch(() => {});
  }
  const zip = new AdmZip();
  if (fs.existsSync(p.identityDir)) zip.addLocalFolder(p.identityDir, `server/${config.get().server.identity}`);
  for (const fwDir of [p.oxideDir, p.carbonDir]) {
    const name = path.basename(fwDir);
    for (const sub of ['config', 'configs', 'data', 'plugins', 'lang']) {
      const full = path.join(fwDir, sub);
      if (fs.existsSync(full)) zip.addLocalFolder(full, `${name}/${sub}`);
    }
  }
  zip.addFile('panel-config.json', Buffer.from(JSON.stringify({ server: config.get().server }, null, 2)));
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(backupDir(), `backup_${stamp}_${label.replace(/[^\w-]/g, '')}.zip`);
  await new Promise((res, rej) => zip.writeZip(file, (e) => (e ? rej(e) : res())));
  log('panel', L('backup_created', { name: path.basename(file) }));
  pruneBackups();
  return path.basename(file);
}

function listBackups() {
  const d = backupDir();
  return fs.readdirSync(d).filter(f => f.endsWith('.zip')).map(f => {
    const st = fs.statSync(path.join(d, f));
    return { name: f, size: st.size, created: st.mtimeMs };
  }).sort((a, b) => b.created - a.created);
}

function safeBackupPath(name) {
  if (!/^[\w.-]+\.zip$/.test(name)) throw E('bad_backup_name');
  const f = path.join(backupDir(), name);
  if (!fs.existsSync(f)) throw E('backup_not_found');
  return f;
}

function deleteBackup(name) { fs.rmSync(safeBackupPath(name)); }

function restoreBackup(name) {
  if (server.isRunning()) throw E('stop_before_restore');
  const zip = new AdmZip(safeBackupPath(name));
  zip.extractAllTo(config.serverPaths().root, true);
  log('panel', L('backup_restored', { name }));
}

function pruneBackups() {
  const keep = config.get().schedule.keepBackups || 10;
  listBackups().slice(keep).forEach(b => fs.rmSync(path.join(backupDir(), b.name), { force: true }));
}

// ---------- Wipe ----------
function wipe({ blueprints = false, newSeed = false, backup = true } = {}) {
  if (server.isRunning()) throw E('stop_before_wipe');
  return (async () => {
    if (backup) await createBackup(blueprints ? 'pre-bpwipe' : 'pre-wipe');
    const dir = config.serverPaths().identityDir;
    let removed = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const isMap = /\.(map|sav)(\.\d+)?$/.test(f) || /^player\.(states|deaths)\..*\.db/.test(f) || /^sv\.files\..*\.db/.test(f) || /^relationship/.test(f);
        const isBp = /^player\.blueprints\..*\.db/.test(f);
        if (isMap || (blueprints && isBp)) {
          fs.rmSync(path.join(dir, f), { force: true, recursive: true });
          removed.push(f);
        }
      }
    }
    if (newSeed) config.update('server', { seed: Math.floor(Math.random() * 2147483647) });
    log('panel', L(blueprints ? 'wipe_full' : 'wipe_map', { n: removed.length, seed: config.get().server.seed }));
    return { removed, seed: config.get().server.seed };
  })();
}

// ---------- Programador ----------
const WARN_AT = [60, 30, 15, 10, 5, 3, 2, 1];
const warned = new Set();
const lastAnnounce = new Map();
let restarting = false;

function nextRestart(now = new Date()) {
  const times = config.get().schedule.restarts || [];
  let best = null;
  for (const t of times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) continue;
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  return best;
}

async function scheduledRestart() {
  if (restarting) return;
  restarting = true;
  try {
    const s = config.get().schedule;
    log('panel', L('sched_restart'));
    if (config.isRemote()) { await server.restart(); return; } // sin archivos: ni copia ni actualización
    await server.stop();
    if (s.autoBackupOnRestart) await createBackup('auto').catch(e => log('panel', L('backup_failed', { error: errParam(e) })));
    if (s.autoUpdateOnRestart) await installer.installServer({ validate: false }).catch(e => log('panel', L('update_failed', { error: errParam(e) })));
    server.start();
  } catch (e) {
    log('panel', L('sched_error', { error: errParam(e) }));
  } finally {
    restarting = false;
    warned.clear();
  }
}

async function tick() {
  const s = config.get().schedule;
  const now = new Date();
  // Reinicios programados con avisos
  if (server.isRunning()) {
    const next = nextRestart(now);
    if (next) {
      const minsLeft = Math.ceil((next - now) / 60000);
      const key = next.getTime();
      const warnWindow = s.restartWarningMinutes || 10;
      for (const w of WARN_AT) {
        if (w <= warnWindow && minsLeft === w && !warned.has(`${key}:${w}`)) {
          warned.add(`${key}:${w}`);
          say(w > 1 ? 'game.restart_in_n' : 'game.restart_in_1', { n: w });
        }
      }
      if (next - now <= 30000 && !warned.has(`${key}:go`)) {
        warned.add(`${key}:go`);
        say('game.restart_now');
        setTimeout(scheduledRestart, 5000);
      }
    }
    // Anuncios periódicos
    (s.announcements || []).forEach((a, i) => {
      if (!a.message || !a.intervalMinutes) return;
      const last = lastAnnounce.get(i) || 0;
      if (Date.now() - last >= a.intervalMinutes * 60000) {
        if (last) rcon.say(a.message).catch(() => {});
        lastAnnounce.set(i, Date.now());
      }
    });
  }
}

function startScheduler() {
  setInterval(() => tick().catch(() => {}), 20000);
}

module.exports = {
  createBackup, listBackups, deleteBackup, restoreBackup, safeBackupPath,
  wipe, startScheduler, nextRestart, scheduledRestart,
};
