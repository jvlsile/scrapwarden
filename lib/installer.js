// Instalador: SteamCMD, servidor Rust (AppID 258550), Oxide/uMod y Carbon
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const config = require('./config');
const { bus, log } = require('./bus');
const { E, L, errParam } = require('./i18n');

const HOST_WIN = config.IS_WIN;
const RUST_APPID = 258550;

// SteamCMD depende del equipo; Oxide/Carbon dependen de la plataforma elegida para el servidor
function urls() {
  const IS_WIN = config.isWin();
  return {
  steamcmd: HOST_WIN
    ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
    : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
  oxide: IS_WIN
    ? 'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip'
    : 'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust-linux.zip',
  carbon: IS_WIN
    ? 'https://github.com/CarbonCommunity/Carbon/releases/download/production_build/Carbon.Windows.Release.zip'
    : 'https://github.com/CarbonCommunity/Carbon/releases/download/production_build/Carbon.Linux.Release.tar.gz',
  };
}

let busy = null; // nombre de la tarea en curso
let prog = null; // { task, phase, pct, overall, done, total }

function state() { return { busy, progress: prog }; }

// Fases con su tramo dentro del porcentaje total de cada tarea
const PHASES = {
  server: { steamcmd_dl: [0, 3], steamcmd_update: [3, 6], allocating: [6, 10], downloading: [10, 82], verifying: [82, 92], committing: [92, 95], framework_dl: [95, 99], framework_extract: [99, 100] },
  oxide: { framework_dl: [0, 85], framework_extract: [85, 100] },
  carbon: { framework_dl: [0, 85], framework_extract: [85, 100] },
};
let lastEmit = 0;
function setProgress(task, phase, pct, done = null, total = null) {
  const range = (PHASES[task] || {})[phase] || [0, 100];
  pct = Math.max(0, Math.min(100, pct));
  const overall = Math.round((range[0] + (range[1] - range[0]) * pct / 100) * 10) / 10;
  prog = { task, phase, pct: Math.round(pct * 10) / 10, overall: Math.max(prog?.task === task ? prog.overall : 0, overall), done, total };
  const now = Date.now();
  if (now - lastEmit > 400 || pct >= 100) { lastEmit = now; bus.emit('progress', prog); }
}

// Interpreta las líneas de SteamCMD
//   [ 45%] Downloading update (12,345 of 38,000 KB)...
//   Update state (0x61) downloading, progress: 45.23 (4567890 / 10123456)
function parseSteamLine(task, line) {
  let m = line.match(/^\[\s*(\d+)%\]/);
  if (m) return setProgress(task, 'steamcmd_update', Number(m[1]));
  m = line.match(/Update state \(0x[0-9a-f]+\)\s+([\w ]+?),\s*progress:\s*([\d.]+)\s*\((\d+)\s*\/\s*(\d+)\)/i);
  if (m) {
    const state = m[1].toLowerCase();
    const phase = state.includes('download') ? 'downloading' : state.includes('verif') ? 'verifying' : state.includes('prealloc') || state.includes('reconfig') ? 'allocating' : state.includes('commit') ? 'committing' : null;
    if (phase) setProgress(task, phase, Number(m[2]), Number(m[3]), Number(m[4]));
  }
  if (/Success! App '\d+' fully installed/i.test(line)) setProgress(task, 'committing', 100);
}

function progress(task, message, done = false, error = false) {
  log('installer', message);
  bus.emit('installer', { task, message, done, error });
}

// Descarga con progreso (onProgress(pct, bytes, total))
async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Scrapwarden/1.0' } });
  if (!res.ok) throw E('download_failed', { status: res.status, url });
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (onProgress) onProgress(total ? got / total * 100 : 0, got, total);
  }
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(dest, buf);
  if (onProgress) onProgress(100, got, total || got);
  return buf.length;
}

function run(cmd, args, opts = {}, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, shell: false });
    let tail = '';
    const handle = (d) => {
      const text = (tail + d.toString()).split(/\r?\n|\r/);
      tail = text.pop();
      text.filter(Boolean).forEach(l => onLine && onLine(l));
    };
    p.stdout.on('data', handle);
    p.stderr.on('data', handle);
    p.on('error', reject);
    p.on('close', (code) => { if (tail && onLine) onLine(tail); resolve(code); });
  });
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    new AdmZip(archive).extractAllTo(destDir, true);
    return Promise.resolve(0);
  }
  return run('tar', ['-xzf', archive, '-C', destDir]);
}

async function withLock(task, fn) {
  if (busy) throw E('task_busy', { task: { k: 'task.' + busy } });
  busy = task;
  prog = { task, phase: 'starting', pct: 0, overall: 0 };
  bus.emit('progress', prog);
  try {
    const r = await fn();
    setProgress(task, Object.keys(PHASES[task]).at(-1), 100);
    progress(task, L('task_done', { task: { k: 'task.' + task } }), true);
    return r;
  } catch (e) {
    progress(task, L('task_failed', { task: { k: 'task.' + task }, error: errParam(e) }), true, true);
    throw e;
  } finally {
    busy = null;
    prog = null;
    bus.emit('progress', null);
  }
}

async function ensureSteamCMD(task) {
  const { steamcmdExe } = config.serverPaths();
  if (fs.existsSync(steamcmdExe)) return;
  const dir = config.get().paths.steamcmd;
  progress(task, L('dl_steamcmd'));
  const archive = path.join(dir, path.basename(urls().steamcmd));
  await download(urls().steamcmd, archive, (pct, d, t) => setProgress(task, 'steamcmd_dl', pct, d, t));
  progress(task, L('extract_steamcmd'));
  await extract(archive, dir);
  fs.rmSync(archive, { force: true });
  if (!HOST_WIN) fs.chmodSync(steamcmdExe, 0o755);
}

// Instala o actualiza el servidor dedicado de Rust
function installServer({ validate = true } = {}) {
  return withLock('server', async () => {
    const task = 'server';
    await ensureSteamCMD(task);
    const c = config.get();
    const { steamcmdExe, root } = config.serverPaths();
    fs.mkdirSync(root, { recursive: true });
    // Fuerza la plataforma de los archivos descargados (permite preparar un servidor Linux desde Windows y viceversa)
    const args = ['+@sSteamCmdForcePlatformType', config.platformName(), '+force_install_dir', root, '+login', 'anonymous', '+app_update', String(RUST_APPID)];
    if (c.server.branch && c.server.branch !== 'public') args.push('-beta', c.server.branch);
    if (validate) args.push('validate');
    args.push('+quit');
    progress(task, L('run_steamcmd', { os: config.isWin() ? 'Windows' : 'Linux', branch: c.server.branch }));
    // SteamCMD a veces devuelve código 8 tras autoactualizarse; se reintenta una vez
    for (let attempt = 1; attempt <= 2; attempt++) {
      const code = await run(steamcmdExe, args, { cwd: c.paths.steamcmd }, l => { parseSteamLine(task, l); progress(task, l); });
      if (fs.existsSync(config.serverPaths().exe) && (code === 0 || code === 7)) break;
      if (attempt === 2) throw E('steamcmd_exit', { code });
      progress(task, L('steamcmd_retry', { code }));
    }
    if (!config.isWin()) try { fs.chmodSync(config.serverPaths().exe, 0o755); } catch {}
    // Si había un framework de mods, hay que reinstalarlo tras actualizar (Steam sobrescribe los DLL)
    setProgress(task, 'committing', 100);
    if (c.server.framework === 'oxide') await installOxideInner(task);
    if (c.server.framework === 'carbon') await installCarbonInner(task);
  });
}

async function installOxideInner(task) {
  const { root } = config.serverPaths();
  progress(task, L('dl_oxide'));
  const tmp = path.join(config.DATA_DIR, 'tmp', path.basename(urls().oxide));
  await download(urls().oxide, tmp, (pct, d, t) => setProgress(task, 'framework_dl', pct, d, t));
  progress(task, L('install_oxide'));
  setProgress(task, 'framework_extract', 10);
  await extract(tmp, root);
  setProgress(task, 'framework_extract', 100);
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.join(root, 'oxide', 'plugins'), { recursive: true });
}

async function installCarbonInner(task) {
  const { root } = config.serverPaths();
  progress(task, L('dl_carbon'));
  const tmp = path.join(config.DATA_DIR, 'tmp', path.basename(urls().carbon));
  await download(urls().carbon, tmp, (pct, d, t) => setProgress(task, 'framework_dl', pct, d, t));
  progress(task, L('install_carbon'));
  setProgress(task, 'framework_extract', 10);
  await extract(tmp, root);
  setProgress(task, 'framework_extract', 100);
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.join(root, 'carbon', 'plugins'), { recursive: true });
}

function installFramework(framework) {
  if (!fs.existsSync(config.serverPaths().exe)) {
    return Promise.reject(E('install_server_first'));
  }
  if (framework === 'oxide') {
    return withLock('oxide', async () => {
      if (fs.existsSync(path.join(config.serverPaths().root, 'carbon'))) {
        progress('oxide', L('carbon_present'));
      }
      await installOxideInner('oxide');
      config.update('server', { framework: 'oxide' });
    });
  }
  if (framework === 'carbon') {
    return withLock('carbon', async () => {
      await installCarbonInner('carbon');
      config.update('server', { framework: 'carbon' });
    });
  }
  if (framework === 'none') {
    // Quitar el framework = revalidar archivos con SteamCMD (restaura los DLL originales)
    if (busy) return Promise.reject(E('task_busy', { task: { k: 'task.' + busy } }));
    const { root } = config.serverPaths();
    // Cargadores de Carbon (Doorstop) que SteamCMD no elimina. Las carpetas de plugins/datos se conservan.
    for (const f of ['winhttp.dll', 'doorstop_config.ini', 'libdoorstop.so']) fs.rmSync(path.join(root, f), { force: true });
    config.update('server', { framework: 'none' });
    return installServer({ validate: true });
  }
  return Promise.reject(E('unknown_framework'));
}

module.exports = { installServer, installFramework, state, _parseSteamLine: parseSteamLine };
