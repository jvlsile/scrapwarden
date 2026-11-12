// Importar un servidor de Rust que ya existe en este equipo: el panel lee su carpeta y su script de arranque
// (.bat/.cmd/.sh) para quedarse con los mismos puertos, identidad, contraseña de RCON, mapa y nombre,
// sin reinstalar ni tocar el mapa, los planos o los plugins.
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const rcon = require('./rcon');
const server = require('./server');
const { log } = require('./bus');
const { E, L } = require('./i18n');

const SCRIPT_EXT = /\.(bat|cmd|sh|ps1)$/i;
const MAX_SCRIPT = 256 * 1024;
// Parámetros de arranque que el panel guarda en su configuración (el resto va a "argumentos extra")
const MAP = {
  'server.port': ['port', 'int'], 'server.queryport': ['queryPort', 'int'], 'rcon.port': ['rconPort', 'int'],
  'rcon.password': ['rconPassword', 'str'], 'app.port': ['appPort', 'int'], 'server.identity': ['identity', 'str'],
  'server.hostname': ['hostname', 'str'], 'server.description': ['description', 'str'], 'server.url': ['url', 'str'],
  'server.headerimage': ['headerimage', 'str'], 'server.maxplayers': ['maxplayers', 'int'], 'server.level': ['level', 'str'],
  'server.worldsize': ['worldsize', 'int'], 'server.seed': ['seed', 'int'], 'server.saveinterval': ['saveinterval', 'int'],
  'server.tickrate': ['tickrate', 'int'], 'server.pve': ['pve', 'bool'],
};
// Lo que pone siempre el panel al arrancar: no se copia a los argumentos extra
const MANAGED = new Set([...Object.keys(MAP), 'server.ip', 'rcon.ip', 'rcon.web', 'logfile', 'batchmode', 'nographics']);

// Separa un comando en palabras respetando comillas ("a b" o 'a b') y el ^ de continuación de los .bat
function tokens(text) {
  const out = [];
  const src = text.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' ');
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Lee los +parámetros de la línea que lanza RustDedicated
function parseScript(text) {
  const lines = text.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const line = lines.find(l => /RustDedicated/i.test(l) && /\+[\w.]+/.test(l) && !/^\s*(rem|::|#)/i.test(l));
  if (!line) return null;
  const t = tokens(line);
  const params = {}, extra = [];
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (/^[+-][\w.]+$/.test(tok) && !/^-?\d/.test(tok)) {
      const key = tok.slice(1).toLowerCase();
      const next = t[i + 1];
      const hasVal = next !== undefined && !/^[+-][a-z]/i.test(next);
      if (tok[0] === '+') {
        if (hasVal) { params[key] = next; i++; } else params[key] = 'true';
        if (!MANAGED.has(key)) extra.push(tok, ...(hasVal ? [next] : []));
      } else if (!MANAGED.has(key)) {
        // Banderas de Unity (-batchmode, -logfile…): el panel pone las suyas
        if (key === 'logfile' && hasVal) i++;
      } else if (key === 'logfile' && hasVal) i++;
    }
  }
  return { params, extra };
}

// Convars guardadas en server/<identidad>/cfg/server.cfg (por si el .bat no las trae)
function parseCfg(file) {
  const out = {};
  try {
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([\w.]+)\s+"?([^"\r\n]*)"?\s*$/);
      if (m && MAP[m[1].toLowerCase()]) out[m[1].toLowerCase()] = m[2];
    }
  } catch {}
  return out;
}

const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a);

function normalize(dir) {
  let d = String(dir || '').trim().replace(/^"|"$/g, '');
  if (!d) throw E('import_no_dir');
  if (d.startsWith('~')) d = path.join(os.homedir(), d.slice(1));
  if (!path.isAbsolute(d)) throw E('import_relative');
  return path.resolve(d);
}

// Explorador de carpetas para el asistente (solo carpetas, nunca contenido de archivos)
function browse(dir) {
  if (!dir) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(`${l}:\\`); drives.push({ name: `${l}:`, path: `${l}:\\` }); } catch {} }
      return { dir: '', parent: null, dirs: drives, isServer: false };
    }
    dir = '/';
  }
  const d = normalize(dir);
  let entries = [];
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { throw E('import_cant_read', { dir: d }); }
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !/^(\$|System Volume Information|proc|sys|dev)$/i.test(e.name))
    .map(e => ({ name: e.name, path: path.join(d, e.name) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500);
  const isServer = entries.some(e => e.isFile() && /^RustDedicated(\.exe)?$/i.test(e.name));
  const parent = path.dirname(d) === d ? (process.platform === 'win32' ? '' : null) : path.dirname(d);
  return { dir: d, parent, dirs, isServer };
}

async function scan(dir) {
  const root = normalize(dir);
  let st;
  try { st = fs.statSync(root); } catch { throw E('import_not_found', { dir: root }); }
  if (!st.isDirectory()) throw E('import_not_found', { dir: root });
  const exeWin = fs.existsSync(path.join(root, 'RustDedicated.exe'));
  const exeLin = fs.existsSync(path.join(root, 'RustDedicated'));
  if (!exeWin && !exeLin) throw E('import_no_exe', { dir: root });
  const platform = exeWin && !exeLin ? 'windows' : exeLin && !exeWin ? 'linux' : (config.IS_WIN ? 'windows' : 'linux');
  const warnings = [];
  if ((platform === 'windows') !== config.IS_WIN) warnings.push('platform');

  // Framework por carpetas
  const managed = path.join(root, 'RustDedicated_Data', 'Managed');
  let framework = 'none';
  if (fs.existsSync(path.join(root, 'carbon'))) framework = 'carbon';
  else if (fs.existsSync(path.join(root, 'oxide')) || fs.existsSync(path.join(managed, 'Oxide.Rust.dll'))) framework = 'oxide';

  // Scripts de arranque (en la carpeta y en la de arriba, que es donde suelen estar)
  const scripts = [];
  for (const base of [root, path.dirname(root)]) {
    let list = [];
    try { list = fs.readdirSync(base, { withFileTypes: true }); } catch {}
    for (const e of list) {
      if (!e.isFile() || !SCRIPT_EXT.test(e.name)) continue;
      const f = path.join(base, e.name);
      try {
        if (fs.statSync(f).size > MAX_SCRIPT) continue;
        const parsed = parseScript(fs.readFileSync(f, 'utf8'));
        if (parsed) scripts.push({ file: f, name: e.name, ...parsed });
      } catch {}
    }
  }
  // El script con más parámetros suele ser el bueno
  scripts.sort((a, b) => Object.keys(b.params).length - Object.keys(a.params).length);
  const script = scripts[0] || null;
  if (!script) warnings.push('no_script');

  // Identidades (carpetas en server/)
  const idRoot = path.join(root, 'server');
  let identities = [];
  try {
    identities = fs.readdirSync(idRoot, { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => { let t = 0; try { t = fs.statSync(path.join(idRoot, e.name)).mtimeMs; } catch {} return { name: e.name, t }; })
      .sort((a, b) => b.t - a.t).map(x => x.name);
  } catch {}
  const identity = (script?.params['server.identity'] && /^[\w-]{1,48}$/.test(script.params['server.identity']) ? script.params['server.identity'] : null) || identities[0] || null;
  if (!identity) warnings.push('no_identity');

  // Valores: primero el script, después server.cfg
  const raw = { ...(identity ? parseCfg(path.join(idRoot, identity, 'cfg', 'server.cfg')) : {}), ...(script?.params || {}) };
  const settings = {};
  for (const [k, [field, type]] of Object.entries(MAP)) {
    if (raw[k] === undefined) continue;
    let v = raw[k];
    if (type === 'int') { v = parseInt(v, 10); if (Number.isNaN(v)) continue; }
    if (type === 'bool') v = /^(1|true)$/i.test(String(v));
    settings[field] = v;
  }
  if (identity) settings.identity = identity;
  if (raw['rcon.web'] !== undefined && /^(0|false)$/i.test(raw['rcon.web'])) warnings.push('rcon_web_off');
  if (!settings.rconPassword) warnings.push('no_rcon_password');

  // ¿Está encendido? Se prueba RCON en este equipo con lo encontrado
  let running = null;
  if (settings.rconPassword) {
    const r = await rcon.probe({ host: '127.0.0.1', port: settings.rconPort || 28016, password: settings.rconPassword }, 3000);
    running = r.ok ? { hostname: r.info?.Hostname || '', players: r.info?.Players ?? null } : null;
  }

  return {
    dir: root, platform, framework, identities, identity,
    script: script ? { name: script.name, file: script.file } : null,
    settings: { ...settings, rconPassword: undefined }, hasRconPassword: !!settings.rconPassword,
    extraArgs: script ? script.extra.map(quoteArg).join(' ') : '',
    running, warnings,
  };
}

async function apply(input = {}) {
  if (server.isManaged()) throw E('stop_before_import');
  const found = await scan(input.dir);
  // La contraseña la puede escribir el usuario si el script no la tenía
  const pass = String(input.rconPassword || '').trim();
  const raw = { ...found.settings };
  // Volver a leer la contraseña (scan no la devuelve a la interfaz)
  const again = parseScript(found.script ? fs.readFileSync(found.script.file, 'utf8') : '')?.params || {};
  const cfgPass = found.identity ? parseCfg(path.join(found.dir, 'server', found.identity, 'cfg', 'server.cfg'))['rcon.password'] : undefined;
  const rconPassword = pass || again['rcon.password'] || cfgPass || config.get().server.rconPassword;
  if (String(rconPassword).length < 6) throw E('rcon_password_short');
  const identity = /^[\w-]{1,48}$/.test(String(input.identity || '')) ? input.identity : found.identity;
  if (!identity) throw E('bad_identity');

  const update = { mode: 'local', platform: found.platform, framework: found.framework, ...raw, identity, rconPassword };
  if (input.keepExtra !== false && found.extraArgs) update.extraArgs = found.extraArgs;
  for (const k of Object.keys(update)) if (update[k] === undefined) delete update[k];
  config.update('paths', { server: found.dir });
  config.update('server', update);
  log('panel', L('imported', { dir: found.dir, id: identity }));
  server.reconnect(); // si ya está encendido, el panel se conecta a él
  return { ok: true, dir: found.dir, identity, running: !!found.running };
}

module.exports = { scan, apply, browse, parseScript };
