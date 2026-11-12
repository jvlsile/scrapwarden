// Gestión de la configuración persistente del panel (data/config.json)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const IS_WIN = process.platform === 'win32'; // sistema donde se ejecuta el panel

const defaults = {
  panel: {
    port: 8080,
    notifyLang: 'es',     // idioma de los avisos en el chat del juego y en Discord
    itemIcons: 'https://files.facepunch.com/rust/item/{shortname}_512.png', // imágenes oficiales de Facepunch ('' = sin imágenes); si falla una se prueba rustlabs
    updateCheck: true,    // consultar en GitHub si hay una versión nueva del panel
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  },
  paths: {
    steamcmd: path.join(ROOT, 'steamcmd'),
    server: path.join(ROOT, 'server'),
    backups: path.join(ROOT, 'backups'),
  },
  server: {
    mode: 'local',             // local (servidor en este equipo) | remote (solo RCON a otra máquina)
    platform: 'auto',          // auto | windows | linux (archivos del servidor que se descargan)
    branch: 'public',          // public | staging | aux01 ...
    framework: 'none',         // none | oxide | carbon
    identity: 'rust_server',
    hostname: 'Mi Servidor Rust | Panel',
    description: 'Servidor administrado con Scrapwarden',
    url: '',
    headerimage: '',
    port: 28015,
    queryPort: 28017,
    rconPort: 28016,
    rconPassword: crypto.randomBytes(9).toString('base64url'),
    appPort: 28082,
    maxplayers: 50,
    level: 'Procedural Map',
    worldsize: 3500,
    seed: Math.floor(Math.random() * 2147483647),
    saveinterval: 300,
    tickrate: 30,
    pve: false,
    highPriority: false,       // prioridad alta del proceso RustDedicated
    extraArgs: '',
    autostart: false,
    autoRestartOnCrash: true,
  },
  remote: {                    // modo remoto: servidor alquilado o en otra máquina, solo por RCON
    host: '',
    rconPort: 28016,
    rconPassword: '',
  },
  rates: {},                  // ver lib/rates.js (DEFAULTS)
  schedule: {
    restarts: [],              // ["06:00", "18:00"] hora local
    restartWarningMinutes: 10,
    announcements: [],         // [{ message, intervalMinutes }]
    autoUpdateOnRestart: false,
    autoBackupOnRestart: true,
    keepBackups: 10,
  },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let config = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
      console.error('config.json corrupto, se usan valores por defecto:', e.message);
    }
  }
  config = deepMerge(defaults, stored);
  save();
  return config;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function get() { return config || load(); }

function update(section, values) {
  get();
  config[section] = deepMerge(config[section] || {}, values);
  save();
  return config[section];
}

// Plataforma elegida para el servidor (por defecto, la del equipo)
function isWin() {
  const p = get().server.platform;
  return p === 'windows' || (p !== 'linux' && IS_WIN);
}
function platformName() { return isWin() ? 'windows' : 'linux'; }
// Modo remoto: el panel no tiene acceso a los archivos ni al proceso, solo a RCON
const isRemote = () => get().server.mode === 'remote';
// Dónde conectar por RCON según el modo
function rconTarget() {
  const c = get();
  if (isRemote()) return { host: c.remote.host, port: c.remote.rconPort, password: c.remote.rconPassword };
  return { host: '127.0.0.1', port: c.server.rconPort, password: c.server.rconPassword };
}

// Rutas derivadas del servidor
function serverPaths() {
  const c = get();
  const srv = c.paths.server;
  return {
    root: srv,
    exe: path.join(srv, isWin() ? 'RustDedicated.exe' : 'RustDedicated'),
    identityDir: path.join(srv, 'server', c.server.identity),
    oxideDir: path.join(srv, 'oxide'),
    carbonDir: path.join(srv, 'carbon'),
    steamcmdExe: path.join(c.paths.steamcmd, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh'), // binario del equipo anfitrión
  };
}

module.exports = { load, save, get, update, serverPaths, isWin, platformName, isRemote, rconTarget, ROOT, DATA_DIR, IS_WIN };
