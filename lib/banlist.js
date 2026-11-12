// Baneos compartidos: Oxidian hace de servidor de "Centralized Banning" de Facepunch.
// Rust consulta GET {server.bansServerEndpoint}{steamID64} cada vez que alguien entra:
//   404 -> no está baneado | 2xx + JSON { steamId, reason, expiryDate, isMute } -> baneado o silenciado
// Así un baneo hecho en un servidor vale para todos los que usen la misma dirección, incluso en vanilla.
// Además se pueden consultar listas externas que sigan el mismo formato (Server Armour, otro Oxidian...).
//
// Seguridad:
//  - Cada servidor que consulta usa una clave secreta en la ruta (256 bits); se comparan en tiempo constante.
//  - Solo se responde por un SteamID concreto: no se puede descargar la lista.
//  - Límite de consultas por clave y bloqueo temporal de IPs que prueban claves falsas.
//  - A las listas externas solo se envía el SteamID; nunca IPs ni nombres.
//  - Las consultas encadenadas llevan una cabecera para evitar bucles entre paneles.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const rcon = require('./rcon');
const { bus, log } = require('./bus');
const { E, L, errParam } = require('./i18n');

const FILE = path.join(config.DATA_DIR, 'banlist.json');
const CHAIN_HEADER = 'x-oxidian-chain';
const TEST_ID = '76561197960287930'; // SteamID de ejemplo de la documentación de Valve
const MAX_SOURCES = 8;
const MAX_KEYS = 20;
const UPSTREAM_TIMEOUT = 2500;       // Rust espera 5 s por defecto: hay margen
const CACHE_HIT_MS = 15 * 60000;
const CACHE_MISS_MS = 15 * 60000;
const CACHE_ERR_MS = 2 * 60000;

const DEFAULTS = {
  enabled: false,
  applyLocal: true,       // configurar solo el servidor que gestiona este panel
  failureMode: 0,         // 0: si el panel no responde, se deja entrar | 1: se rechaza
  publicUrl: '',          // dirección del panel vista desde otros servidores (p. ej. http://1.2.3.4:8080)
  shareMutes: true,       // los silencios del panel también se aplican en los demás servidores
  keys: [],               // [{ id, name, token, created, lastUsed, hits, local }]
  sources: [],            // [{ id, name, url, mode: 'alert'|'block', enabled }]
};

// ---------- Datos ----------
let data = { manual: {}, server: {}, syncedAt: 0 };
try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE); // escritura atómica: un corte de luz no deja el archivo a medias
  }, 1000);
}

const settings = () => {
  const s = { ...DEFAULTS, ...(config.get().banlist || {}) };
  s.keys = Array.isArray(s.keys) ? s.keys : [];
  s.sources = Array.isArray(s.sources) ? s.sources : [];
  return s;
};
const saveSettings = (s) => config.update('banlist', s);
const newToken = () => crypto.randomBytes(32).toString('hex');
const newId = () => crypto.randomBytes(6).toString('hex');
const validId = (v) => /^7656\d{13}$/.test(String(v || ''));
const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// ---------- Baneos del servidor (lista nativa de Rust) ----------
// banlistex: "<n> <steamid> "<nombre>" "<motivo>" <caducidad unix | -1>"
function parseBanlist(out) {
  const res = {};
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/\b(7656\d{13})\b(.*)$/);
    if (!m) continue;
    const quoted = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]);
    const tail = m[2].replace(/"((?:[^"\\]|\\.)*)"/g, '').trim().match(/^(-?\d+)/);
    const exp = tail ? parseInt(tail[1], 10) : -1;
    res[m[1]] = { name: clip(quoted[0], 64), reason: clip(quoted[1], 200), expiry: exp > 0 ? exp * 1000 : 0 };
  }
  return res;
}
// Lo llama vigilancia cada vez que lee la lista de baneos del servidor
function ingestServerBans(out) {
  data.server = parseBanlist(out);
  data.syncedAt = Date.now();
  save();
}

// ---------- Consulta local ----------
function moderation() { return require('./moderation'); }
function localLookup(id) {
  const now = Date.now();
  const m = data.manual[id];
  if (m && !m.isMute && (!m.expiry || m.expiry > now)) return { steamId: id, reason: m.reason, expiry: m.expiry || 0, isMute: false, source: 'manual' };
  const sv = data.server[id];
  if (sv && (!sv.expiry || sv.expiry > now)) {
    // Los baneos temporales del panel se guardan en Rust como permanentes y el panel los quita al caducar
    let expiry = sv.expiry || 0;
    try { const tb = moderation().player(id)?.tempban; if (tb?.until) expiry = tb.until; } catch {}
    return { steamId: id, reason: sv.reason, expiry, isMute: false, source: 'server' };
  }
  if (settings().shareMutes) {
    if (m && m.isMute && (!m.expiry || m.expiry > now)) return { steamId: id, reason: m.reason, expiry: m.expiry || 0, isMute: true, source: 'manual' };
    try { const mu = moderation().player(id)?.mute; if (mu && (!mu.until || mu.until > now)) return { steamId: id, reason: mu.reason || '', expiry: mu.until || 0, isMute: true, source: 'mute' }; } catch {}
  }
  return null;
}

// ---------- Listas externas ----------
const cache = new Map(); // "fuente|steamid" -> { t, hit, err }
function sourceUrl(base, id) {
  const b = String(base);
  return (/[/=]$/.test(b) ? b : b + '/') + id;
}
function validSourceUrl(u) {
  try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) && !x.username && !x.password && u.length <= 300; } catch { return false; }
}
async function querySource(src, id) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(sourceUrl(src.url, id), {
    headers: { 'User-Agent': 'Oxidian', Accept: 'application/json', [CHAIN_HEADER]: '1' },
      redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw E('banlist_src_timeout');
    throw E('banlist_src_unreachable');
  }
  const ms = Date.now() - t0;
  if (res.status === 404) { res.body?.cancel?.().catch(() => {}); return { hit: null, ms }; }
  if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw E('banlist_src_status', { status: res.status }); }
  const text = await res.text();
  if (text.length > 16384) throw E('banlist_src_format');
  let j; try { j = JSON.parse(text); } catch { throw E('banlist_src_format'); }
  if (!j || String(j.steamId) !== id) throw E('banlist_src_format'); // misma comprobación que hace Rust
  const exp = Number(j.expiryDate) || 0;
  if (exp > 0 && exp * 1000 <= Date.now()) return { hit: null, ms };
  return { hit: { steamId: id, reason: clip(j.reason, 200), expiry: exp > 0 ? exp * 1000 : 0, isMute: !!j.isMute }, ms };
}
async function cachedSource(src, id) {
  const key = src.id + '|' + id;
  const c = cache.get(key), now = Date.now();
  if (c && now - c.t < (c.err ? CACHE_ERR_MS : c.hit ? CACHE_HIT_MS : CACHE_MISS_MS)) return c;
  try { const r = await querySource(src, id); const v = { t: now, hit: r.hit }; cache.set(key, v); return v; }
  catch (e) {
    const v = { t: now, hit: null, err: errParam(e) }; cache.set(key, v);
    if (!c || !c.err) log('panel', L('banlist_src_error', { name: src.name, error: errParam(e) }));
    return v;
  }
}
// Busca en las listas externas activas (en paralelo). mode: 'block' | 'all'
async function remoteLookup(id, mode = 'block') {
  const srcs = settings().sources.filter(s => s.enabled && (mode === 'all' || s.mode === 'block'));
  if (!srcs.length) return [];
  const out = await Promise.all(srcs.map(async (s) => ({ source: s, r: await cachedSource(s, id) })));
  return out.filter(x => x.r.hit && !x.r.hit.isMute).map(x => ({ ...x.r.hit, source: 'ext', sourceId: x.source.id, sourceName: x.source.name, mode: x.source.mode }));
}
// Para el endpoint: responde en cuanto una lista encuentra el baneo, sin esperar a las lentas
function firstRemoteHit(id) {
  const srcs = settings().sources.filter(s => s.enabled && s.mode === 'block');
  if (!srcs.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let left = srcs.length;
    for (const src of srcs) {
      cachedSource(src, id).then((r) => {
        if (r.hit && !r.hit.isMute) resolve({ ...r.hit, source: 'ext', sourceName: src.name });
        else if (--left === 0) resolve(null);
      }, () => { if (--left === 0) resolve(null); });
    }
  });
}
function cleanCache() { const now = Date.now(); for (const [k, v] of cache) if (now - v.t > CACHE_HIT_MS * 2) cache.delete(k); }
setInterval(cleanCache, 10 * 60000).unref();

// ---------- Endpoint para Rust ----------
const badTries = new Map();  // ip -> { n, since, blockedUntil }
const keyRate = new Map();   // keyId -> { n, since }
let usageDirty = false;
function tokenMatch(token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const a = Buffer.from(token, 'hex');
  let found = null;
  for (const k of settings().keys) {
    const b = Buffer.from(String(k.token || ''), 'hex');
    if (b.length === a.length && crypto.timingSafeEqual(a, b)) found = k; // sin salir antes: mismo tiempo siempre
  }
  return found;
}
function clientIp(req) { return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''); }

async function handle(req, res) {
  res.set('Cache-Control', 'no-store');
  const ip = clientIp(req), now = Date.now();
  const s = settings();
  const key = s.enabled ? tokenMatch(String(req.params.token || '')) : null;
  if (!key) {
    // Las claves tienen 256 bits (imposibles de adivinar); el bloqueo solo corta el ruido de quien prueba
    const bt = badTries.get(ip);
    if (bt?.blockedUntil > now) return res.status(429).end();
    if (s.enabled) {
      const b = bt && now - bt.since < 10 * 60000 ? bt : { n: 0, since: now };
      b.n++;
      if (b.n >= 30) { b.blockedUntil = now + 30 * 60000; log('panel', L('banlist_blocked_ip', { ip })); }
      badTries.set(ip, b);
    }
    return res.status(s.enabled ? 403 : 404).end();
  }
  const kr = keyRate.get(key.id);
  const r = kr && now - kr.since < 60000 ? kr : { n: 0, since: now };
  r.n++; keyRate.set(key.id, r);
  if (r.n > 1500) return res.status(429).end();

  const id = String(req.params.steamid || '');
  if (!validId(id)) return res.status(400).end();
  key.lastUsed = now; key.hits = (key.hits || 0) + 1; usageDirty = true;

  let hit = localLookup(id);
  if (!hit && !req.get(CHAIN_HEADER)) {
    try { hit = await firstRemoteHit(id); } catch { hit = null; }
  }
  if (!hit) return res.status(404).end();
  res.json({ steamId: id, reason: hit.reason || '', expiryDate: hit.expiry ? Math.floor(hit.expiry / 1000) : 0, isMute: !!hit.isMute });
}
// El uso de las claves se guarda cada minuto, no en cada consulta
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  const cur = settings();
  saveSettings({ keys: cur.keys.map(k => ({ ...k })) });
}, 60000).unref();
setInterval(() => { const now = Date.now(); for (const [ip, b] of badTries) if (now - b.since > 3600000 && !(b.blockedUntil > now)) badTries.delete(ip); }, 600000).unref();

// ---------- Aplicar al servidor gestionado ----------
let applied = { ok: false, url: null, error: null, at: 0 };
function panelPort() { return parseInt(process.env.PORT || config.get().panel.port, 10) || 8080; }
function localKey(s = settings()) {
  let k = s.keys.find(x => x.local);
  if (!k) {
    k = { id: newId(), name: '', token: newToken(), created: Date.now(), lastUsed: 0, hits: 0, local: true };
    s.keys = [k, ...s.keys];
    saveSettings({ keys: s.keys });
  }
  return k;
}
function baseUrl(s = settings()) {
  if (config.isRemote()) return s.publicUrl ? s.publicUrl.replace(/\/+$/, '') : null;
  return `http://127.0.0.1:${panelPort()}`;
}
const endpointFor = (k, s = settings()) => { const b = baseUrl(s); return b ? `${b}/rustbans/${k.token}/` : null; };
function publicEndpointFor(k, s = settings()) {
  const b = s.publicUrl ? s.publicUrl.replace(/\/+$/, '') : null;
  return b ? `${b}/rustbans/${k.token}/` : `http://<IP-DEL-PANEL>:${panelPort()}/rustbans/${k.token}/`;
}

async function applyLocal() {
  const s = settings();
  if (!rcon.isConnected()) return applied;
  try {
    if (s.enabled && s.applyLocal) {
      const url = endpointFor(localKey(s), s);
      if (!url) { applied = { ok: false, url: null, error: 'banlist_need_public_url', at: Date.now() }; return applied; }
      await rcon.command(`server.bansServerFailureMode ${s.failureMode ? 1 : 0}`);
      await rcon.command(`server.bansServerEndpoint "${url}"`);
      const back = await rcon.command('server.bansServerEndpoint');
      if (!String(back).includes(url)) throw E('banlist_not_supported');
      await rcon.command('server.writecfg').catch(() => {});
      if (!applied.ok || applied.url !== url) log('panel', L('banlist_applied'));
      applied = { ok: true, url, error: null, at: Date.now() };
    } else if (applied.ok || s.applyLocal === false || !s.enabled) {
      // Si estaba puesto por el panel, se quita
      const back = String(await rcon.command('server.bansServerEndpoint').catch(() => ''));
      if (/\/rustbans\/[0-9a-f]{64}\//.test(back)) {
        await rcon.command('server.bansServerEndpoint ""');
        await rcon.command('server.writecfg').catch(() => {});
        log('panel', L('banlist_removed'));
      }
      applied = { ok: false, url: null, error: null, at: Date.now() };
    }
  } catch (e) {
    applied = { ok: false, url: null, error: e.code || 'banlist_apply_failed', at: Date.now() };
    log('panel', L('banlist_apply_failed', { error: errParam(e) }));
  }
  return applied;
}

// ---------- Jugadores que entran: listas externas en modo aviso y expulsión de respaldo ----------
const seen = new Map(); // steamid -> momento de la última comprobación
async function onPlayerSeen(id, name, { addAlert, kick } = {}) {
  const s = settings();
  if (!s.enabled || !validId(id)) return;
  if (Date.now() - (seen.get(id) || 0) < 30 * 60000) return;
  seen.set(id, Date.now());
  // Respaldo: un baneo manual o externo en modo bloqueo expulsa aunque el servidor no consulte la lista
  const local = localLookup(id);
  if (local && !local.isMute && local.source === 'manual' && kick) { await kick(id, local.reason); return; }
  let hits = [];
  try { hits = await remoteLookup(id, 'all'); } catch { return; }
  for (const h of hits) {
    const kicked = h.mode === 'block' && kick ? await kick(id, h.reason).then(() => true, () => false) : false;
    addAlert?.({
      severity: h.mode === 'block' ? 'high' : 'medium', kind: 'banlist', code: 'banlist_hit',
      params: { source: h.sourceName, reason: h.reason || '—', action: kicked ? { k: 'alert.kicked' } : '' },
      steamid: id, name, evidence: { source: h.sourceName, reason: h.reason, expiry: h.expiry || 0 },
    });
  }
}

// ---------- API del panel ----------
function view() {
  const s = settings();
  localKey(s);
  const cur = settings();
  return {
    enabled: cur.enabled, applyLocal: cur.applyLocal, failureMode: cur.failureMode ? 1 : 0, publicUrl: cur.publicUrl, shareMutes: cur.shareMutes,
    remote: config.isRemote(), port: panelPort(),
    applied: { ...applied, url: undefined },
    keys: cur.keys.map(k => ({ id: k.id, name: k.name, local: !!k.local, created: k.created, lastUsed: k.lastUsed || 0, hits: k.hits || 0, hint: k.token.slice(0, 4) + '…' + k.token.slice(-4) })),
    sources: cur.sources.map(x => ({ ...x })),
    syncedAt: data.syncedAt,
  };
}
function entries() {
  const now = Date.now();
  const out = [];
  let mod = null; try { mod = moderation(); } catch {}
  for (const [id, sv] of Object.entries(data.server)) {
    let expiry = sv.expiry || 0;
    try { const tb = mod?.player(id)?.tempban; if (tb?.until) expiry = tb.until; } catch {}
    if (expiry && expiry <= now) continue;
    out.push({ steamId: id, name: sv.name, reason: sv.reason, expiry, isMute: false, source: 'server' });
  }
  for (const m of Object.values(data.manual)) {
    if (m.expiry && m.expiry <= now) continue;
    if (!m.isMute && out.some(o => o.steamId === m.steamId)) continue;
    out.push({ steamId: m.steamId, name: m.name, reason: m.reason, expiry: m.expiry || 0, isMute: !!m.isMute, source: 'manual', by: m.by, created: m.created });
  }
  if (settings().shareMutes && mod) {
    for (const a of mod.active()) if (a.mute && (!a.mute.until || a.mute.until > now) && !data.manual[a.steamid]?.isMute) {
      out.push({ steamId: a.steamid, name: a.name, reason: a.mute.reason || '', expiry: a.mute.until || 0, isMute: true, source: 'mute' });
    }
  }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}

async function update(v = {}) {
  const s = settings(), out = {};
  if ('enabled' in v) out.enabled = !!v.enabled;
  if ('applyLocal' in v) out.applyLocal = !!v.applyLocal;
  if ('shareMutes' in v) out.shareMutes = !!v.shareMutes;
  if ('failureMode' in v) out.failureMode = String(v.failureMode) === '1' ? 1 : 0;
  if ('publicUrl' in v) {
    const u = String(v.publicUrl || '').trim().replace(/\/+$/, '');
    if (u && !validSourceUrl(u)) throw E('banlist_bad_url');
    out.publicUrl = u;
  }
  saveSettings({ ...s, ...out });
  localKey();
  await applyLocal().catch(() => {});
  return view();
}

function addKey(name) {
  const s = settings();
  if (s.keys.filter(k => !k.local).length >= MAX_KEYS) throw E('banlist_too_many');
  const k = { id: newId(), name: clip(name, 40) || '—', token: newToken(), created: Date.now(), lastUsed: 0, hits: 0 };
  saveSettings({ keys: [...s.keys, k] });
  return { id: k.id, url: publicEndpointFor(k) };
}
function revealKey(id) {
  const k = settings().keys.find(x => x.id === id);
  if (!k) throw E('not_found');
  const url = (k.local && endpointFor(k)) || publicEndpointFor(k); // la clave local es la que usa el servidor de este panel
  return { id: k.id, url, command: `server.bansServerEndpoint "${url}"`, needsPublicUrl: url.includes('<') };
}
async function rotateKey(id) {
  const s = settings();
  const k = s.keys.find(x => x.id === id);
  if (!k) throw E('not_found');
  k.token = newToken(); k.lastUsed = 0; k.hits = 0;
  saveSettings({ keys: s.keys });
  if (k.local) await applyLocal();
  return revealKey(id);
}
function removeKey(id) {
  const s = settings();
  const k = s.keys.find(x => x.id === id);
  if (!k) throw E('not_found');
  if (k.local) throw E('banlist_local_key');
  saveSettings({ keys: s.keys.filter(x => x.id !== id) });
  return { ok: true };
}

async function addBan({ steamId, name, reason, minutes, isMute }, by) {
  if (!validId(steamId)) throw E('bad_steamid');
  const m = Math.max(0, parseInt(minutes, 10) || 0);
  data.manual[steamId] = {
    steamId, name: clip(name, 64), reason: clip(reason, 200), isMute: !!isMute,
    expiry: m ? Date.now() + m * 60000 : 0, by: clip(by, 40), created: Date.now(),
  };
  save();
  bus.emit('banlist', { kind: 'add', steamId });
  // Si está dentro del servidor de este panel, se le expulsa ya (Rust solo comprueba al entrar)
  if (!isMute && rcon.isConnected()) await rcon.command(`kick ${steamId} "${clip(reason, 120).replace(/"/g, "'") || 'Banned'}"`).catch(() => {});
  return data.manual[steamId];
}
async function removeBan(steamId) {
  if (!validId(steamId)) throw E('bad_steamid');
  let changed = false;
  if (data.manual[steamId]) { delete data.manual[steamId]; changed = true; }
  if (data.server[steamId] && rcon.isConnected()) {
    await rcon.command(`unban ${steamId}`);
    await rcon.command('server.writecfg').catch(() => {});
    delete data.server[steamId]; changed = true;
    try { moderation().clearTempban(steamId); } catch {}
    try { require('./watch').markBanned(steamId, false); } catch {}
  }
  if (!changed && data.server[steamId]) throw E('rcon_not_connected');
  save();
  for (const k of [...cache.keys()]) if (k.endsWith('|' + steamId)) cache.delete(k);
  bus.emit('banlist', { kind: 'remove', steamId });
  return { ok: true };
}

function setSources(list) {
  if (!Array.isArray(list)) throw E('bad_value', { value: 'sources' });
  if (list.length > MAX_SOURCES) throw E('banlist_too_many');
  const cur = settings().sources;
  const out = list.map((x) => {
    const url = String(x.url || '').trim();
    if (settings().keys.some(k => url.includes(k.token))) throw E('banlist_self'); // su propia lista: daría vueltas
    if (!validSourceUrl(url)) throw E('banlist_bad_url');
    const prev = cur.find(c => c.id === x.id);
    return { id: prev ? prev.id : newId(), name: clip(x.name, 40) || new URL(url).hostname, url, mode: x.mode === 'block' ? 'block' : 'alert', enabled: x.enabled !== false };
  });
  saveSettings({ sources: out });
  cache.clear();
  return view();
}
async function testSource(url) {
  url = String(url || '').trim();
  if (!validSourceUrl(url)) throw E('banlist_bad_url');
  const r = await querySource({ url }, TEST_ID);
  return { ok: true, ms: r.ms, banned: !!r.hit };
}
async function check(id) {
  if (!validId(id)) throw E('bad_steamid');
  const local = localLookup(id);
  const ext = await remoteLookup(id, 'all');
  return { local, external: ext.map(h => ({ source: h.sourceName, mode: h.mode, reason: h.reason, expiry: h.expiry })) };
}

function start() {
  bus.on('rcon', (e) => { if (e.connected) setTimeout(() => applyLocal().catch(() => {}), 4000); else applied = { ...applied, ok: false }; });
  // Revisión periódica por si alguien cambia la convar a mano o el servidor se reinicia
  setInterval(() => { if (settings().enabled) applyLocal().catch(() => {}); }, 15 * 60000).unref();
}

module.exports = {
  start, handle, view, entries, update, addKey, revealKey, rotateKey, removeKey, addBan, removeBan,
  setSources, testSource, check, onPlayerSeen, ingestServerBans, applyLocal, parseBanlist, settings, localLookup,
};
