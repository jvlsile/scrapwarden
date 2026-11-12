// Gestión de plugins (Oxide/uMod y Carbon): listar, buscar en uMod, instalar, actualizar, activar/desactivar, configurar.
// Funciona igual con los archivos de este equipo y con un servidor remoto por FTP/SFTP (lib/files.js).
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const files = require('./files');
const { log } = require('./bus');
const { E, L } = require('./i18n');

const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function fw() {
  const f = config.get().server.framework;
  if (f !== 'oxide' && f !== 'carbon') throw E('no_framework');
  return f;
}

// Rutas absolutas en este equipo (las usa también la vigilancia para el complemento)
function dirs() {
  const f = fw();
  const p = config.serverPaths();
  const base = f === 'oxide' ? p.oxideDir : p.carbonDir;
  return {
    framework: f,
    plugins: path.join(base, 'plugins'),
    config: path.join(base, f === 'oxide' ? 'config' : 'configs'),
    data: path.join(base, 'data'),
    lang: path.join(base, 'lang'),
    disabled: path.join(config.DATA_DIR, 'disabled-plugins', f),
    cmd: f === 'oxide' ? 'oxide.' : 'c.',
  };
}

// Rutas para lib/files.js (relativas a la carpeta del servidor)
function rel() {
  const f = fw();
  return {
    plugins: `${f}/plugins`,
    config: `${f}/${f === 'oxide' ? 'config' : 'configs'}`,
    data: `${f}/data`,
    // En local los desactivados se guardan fuera del servidor; en remoto, en una carpeta hermana que el framework no carga
    disabled: config.isRemote() ? `${f}/plugins_disabled` : dirs().disabled,
    cmd: f === 'oxide' ? 'oxide.' : 'c.',
  };
}

function fsx() {
  const f = files.current();
  if (!f) throw E('remote_no_files');
  return f;
}

function checkName(name) {
  if (!NAME_RE.test(name || '')) throw E('bad_plugin_name');
  return name;
}

function parseHeader(src) {
  const info = src.match(/\[Info\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/);
  const desc = src.match(/\[Description\(\s*"([^"]*)"/);
  return {
    title: info?.[1] || null,
    author: info?.[2] || null,
    version: info?.[3] || null,
    description: desc?.[1] || '',
  };
}

async function list() {
  const F = fsx(), d = rel();
  const configs = new Set((await F.list(d.config)).map(e => e.name));
  const out = [];
  for (const [dir, enabled] of [[d.plugins, true], [d.disabled, false]]) {
    for (const e of await F.list(dir)) {
      if (e.dir || !e.name.endsWith('.cs')) continue;
      const name = e.name.slice(0, -3);
      let head = {};
      try { head = parseHeader((await F.read(`${dir}/${e.name}`)).toString('utf8').slice(0, 20000)); } catch {}
      out.push({ name, enabled, ...head, size: e.size, modified: e.mtime, hasConfig: configs.has(`${name}.json`) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function rconSafe(cmd) {
  if (!rcon.isConnected()) return null;
  try { return await rcon.command(cmd); } catch { return null; }
}

// Guarda un plugin .cs (Oxide y Carbon lo cargan automáticamente al detectar el archivo)
async function writePlugin(name, source) {
  checkName(name);
  if (!/class\s+\w+/.test(source) || !/\[Info\(/.test(source)) {
    throw E('bad_plugin_file');
  }
  const F = fsx(), d = rel();
  await F.remove(`${d.disabled}/${name}.cs`);
  await F.write(`${d.plugins}/${name}.cs`, source);
  log('panel', L('plugin_installed', { name }));
  return parseHeader(source);
}

// ---------- uMod ----------
const UMOD = 'https://umod.org';

function mapUmod(p) {
  const name = p.name || p.slug || '';
  return {
    name,
    title: p.title || name,
    description: p.description || '',
    author: p.author || p.author_name || p.owner?.name || '',
    version: p.latest_release_version || p.version || p.latest_version || '',
    downloads: p.downloads || p.downloads_shortened || 0,
    url: p.url || `${UMOD}/plugins/${(p.slug || name).toLowerCase()}`,
    downloadUrl: p.download_url || `${UMOD}/plugins/${name}.cs`,
    icon: p.icon_url || null,
  };
}

async function searchUmod(query = '', page = 1, sort = 'downloads') {
  const params = new URLSearchParams({ query, page: String(page), sort, sortdir: sort === 'title' ? 'asc' : 'desc' });
  params.append('categories[]', 'rust');
  const res = await fetch(`${UMOD}/plugins/search.json?${params}`, { headers: { 'User-Agent': 'Scrapwarden/1.0', Accept: 'application/json' } });
  if (!res.ok) throw E('umod_status', { status: res.status });
  const j = await res.json();
  return {
    page: j.current_page || page,
    lastPage: j.last_page || 1,
    total: j.total || 0,
    results: (j.data || []).map(mapUmod).filter(p => NAME_RE.test(p.name)),
  };
}

async function umodInfo(name) {
  try {
    const r = await fetch(`${UMOD}/plugins/${encodeURIComponent(name)}.json`, { headers: { 'User-Agent': 'Scrapwarden/1.0' } });
    if (r.ok) return mapUmod(await r.json());
  } catch {}
  const s = await searchUmod(name, 1, 'title');
  return s.results.find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
}

async function installFromUmod(name, downloadUrl) {
  checkName(name);
  let url = downloadUrl || `${UMOD}/plugins/${name}.cs`;
  // Sólo se permiten descargas desde umod.org
  if (!/^https:\/\/(www\.)?umod\.org\//.test(url)) url = `${UMOD}/plugins/${name}.cs`;
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Scrapwarden/1.0' } });
  if (!res.ok) throw E('plugin_download', { name, status: res.status });
  const src = await res.text();
  return writePlugin(name, src);
}

function cmpVersion(a = '', b = '') {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function checkUpdates() {
  const installed = await list();
  const results = [];
  // Consultas en serie con pequeña pausa para no saturar uMod
  for (const p of installed) {
    try {
      const info = await umodInfo(p.name);
      results.push({
        name: p.name, installed: p.version, latest: info?.version || null,
        onUmod: !!info, downloadUrl: info?.downloadUrl,
        update: !!(info?.version && p.version && cmpVersion(p.version, info.version) < 0),
      });
    } catch (e) {
      results.push({ name: p.name, installed: p.version, latest: null, onUmod: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// ---------- Activar / desactivar / borrar / recargar ----------
async function setEnabled(name, enabled) {
  checkName(name);
  const F = fsx(), d = rel();
  const from = `${enabled ? d.disabled : d.plugins}/${name}.cs`;
  const to = `${enabled ? d.plugins : d.disabled}/${name}.cs`;
  if (!(await F.exists(from))) throw E('plugin_not_found');
  await F.rename(from, to);
  if (!enabled) await rconSafe(`${d.cmd}unload ${name}`);
  return true;
}

async function remove(name, { purgeData = false } = {}) {
  checkName(name);
  const F = fsx(), d = rel();
  await rconSafe(`${d.cmd}unload ${name}`);
  await F.remove(`${d.plugins}/${name}.cs`);
  await F.remove(`${d.disabled}/${name}.cs`);
  if (purgeData) {
    for (const f of [`${d.config}/${name}.json`, `${d.config}/${name}.json.bak`, `${d.data}/${name}.json`, `${d.data}/${name}`]) await F.remove(f);
  }
  log('panel', L(purgeData ? 'plugin_removed_purge' : 'plugin_removed', { name }));
}

async function reload(name) {
  const d = rel();
  if (name !== '*') checkName(name);
  const out = await rconSafe(`${d.cmd}reload ${name}`);
  if (out === null) throw E('rcon_not_connected');
  return out;
}

async function getConfig(name) {
  checkName(name);
  const F = fsx(), file = `${rel().config}/${name}.json`;
  if (!(await F.exists(file))) throw E('no_plugin_config');
  return (await F.read(file)).toString('utf8');
}

async function saveConfig(name, text) {
  checkName(name);
  try { JSON.parse(text); } catch (e) { throw E('bad_json', { error: e.message }); } // valida antes de guardar
  const F = fsx(), d = rel();
  const file = `${d.config}/${name}.json`;
  if (await F.exists(file)) await F.copy(file, file + '.bak');
  await F.write(file, text);
  await rconSafe(`${d.cmd}reload ${name}`);
}

module.exports = {
  list, searchUmod, installFromUmod, writePlugin, checkUpdates,
  setEnabled, remove, reload, getConfig, saveConfig, dirs, rel, checkName,
};
