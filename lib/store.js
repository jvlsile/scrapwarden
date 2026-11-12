// Tienda (Tebex): el panel hace de "servidor de juego" ante Tebex. Consulta la cola de compras con la clave
// secreta, ejecuta los comandos de cada paquete por RCON y los marca como entregados.
// No hace falta instalar el plugin de Tebex ni abrir puertos: el panel pregunta, Tebex no llama.
// Comando propio para paquetes: oxidian.vip {id} <grupo> <días>  → VIP con caducidad del panel.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const watch = require('./watch');
const vip = require('./vip');
const moderation = require('./moderation');
const audit = require('./audit');
const { bus, log } = require('./bus');
const { E, L, tr, errParam } = require('./i18n');

const API = process.env.TEBEX_API_BASE || 'https://plugin.tebex.io';
const FILE = path.join(config.DATA_DIR, 'store.json');
const DEFAULTS = { enabled: false, secret: '', announce: true, discord: true };
let db = { purchases: [], done: [], totals: { payments: 0, commands: 0 } };
let state = { status: 'off', error: null, account: null, lastCheck: null, nextCheck: null, pending: 0 };
let timer = null, running = false;
const delayed = new Map(); // id del comando → cuándo ejecutarlo (condición "delay" de Tebex)

const settings = () => ({ ...DEFAULTS, ...(config.get().store || {}) });
const lang = () => config.get().panel.notifyLang || 'es';
function load() { try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {} }
function save() { db.purchases = db.purchases.slice(-500); db.done = db.done.slice(-5000); fs.writeFileSync(FILE, JSON.stringify(db)); }

// ---------- API de Tebex ----------
async function tebex(method, p, body, secret = settings().secret) {
  const res = await fetch(API + p, {
    method,
    headers: { 'X-Tebex-Secret': secret, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Oxidian' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw E('store_bad_secret');
  if (res.status === 429) throw E('store_rate_limited');
  if (!res.ok) throw E('store_http', { n: res.status });
  return res.status === 204 ? null : res.json();
}

// ---------- Comandos ----------
const steamOf = (pl) => [pl?.uuid, pl?.id, pl?.name].map(x => String(x ?? '')).find(x => /^\d{17}$/.test(x)) || '';
function fill(cmd, pl) {
  const sid = steamOf(pl), name = String(pl?.name || sid).replace(/["\n\r;]/g, '');
  return String(cmd || '').replace(/\{(id|steamid|uuid|steam_id)\}/gi, sid).replace(/\{(username|name)\}/gi, name).trim();
}
// Lo que viene de Tebex lo escribe el dueño de la tienda, pero no se deja encadenar comandos ni saltos de línea
const safeCmd = (c) => !/[\r\n]/.test(c) && c.length <= 400;

async function run(cmd, pl, ctx) {
  const line = fill(cmd, pl);
  if (!line || !safeCmd(line)) throw E('store_bad_command');
  const m = line.match(/^oxidian\.vip\s+(\d{17})\s+([\w.\-]{1,40})\s+(\d{1,4})$/i);
  if (m) { await vip.grant({ steamid: m[1], name: pl?.name, group: m[2], days: Number(m[3]), note: `Tebex #${ctx.payment}` }, 'tebex'); return line; }
  if (/^oxidian\.vip\b/i.test(line)) throw E('store_bad_vip');
  await rcon.command(line);
  return line;
}

async function onlineIds() {
  const list = await rcon.json('playerlist', 6000).catch(() => []);
  return new Set((Array.isArray(list) ? list : []).map(p => String(p.SteamID)));
}

// ---------- Revisión de la cola ----------
async function check({ force = false } = {}) {
  const s = settings();
  if (!s.enabled || !s.secret) { state.status = 'off'; return view(); }
  if (running) return view();
  if (!rcon.isConnected()) { state.status = 'waiting'; schedule(60); return view(); }
  running = true;
  let next = 120;
  try {
    const q = await tebex('GET', '/queue');
    next = Math.max(60, Math.min(600, Number(q?.meta?.next_check) || 120));
    const done = [], byPayment = new Map();
    const exec = async (c, pl, kind) => {
      if (db.done.includes(c.id)) { done.push(c.id); return; } // ya entregado, solo faltaba borrarlo en Tebex
      const delay = Number(c.conditions?.delay) || 0;
      if (delay > 0) {
        if (!delayed.has(c.id)) delayed.set(c.id, Date.now() + delay * 1000);
        if (delayed.get(c.id) > Date.now()) return;
      }
      const ctx = { payment: c.payment, pkg: c.package };
      let line = '', ok = true, error = null;
      try { line = await run(c.command, pl, ctx); } catch (e) { ok = false; error = errParam(e); line = fill(c.command, pl); }
      delayed.delete(c.id);
      const key = String(c.payment ?? 'x') + ':' + steamOf(pl);
      if (!byPayment.has(key)) byPayment.set(key, { t: Date.now(), payment: c.payment, packages: new Set(), steamid: steamOf(pl), name: String(pl?.name || ''), commands: [], ok: true, kind });
      const p = byPayment.get(key);
      p.packages.add(c.package); p.commands.push({ line, ok, error }); if (!ok) p.ok = false;
      // Si falla porque se cayó RCON se reintenta en la próxima revisión; si el comando está mal, se descarta
      if (ok || !(error && error.k && /^err\.rcon_/.test(error.k))) { done.push(c.id); db.done.push(c.id); }
      else p.retry = true;
    };
    if (q?.meta?.execute_offline) {
      const off = await tebex('GET', '/queue/offline-commands');
      for (const c of off?.commands || []) await exec(c, c.player, 'offline');
    }
    const players = q?.players || [];
    if (players.length) {
      const online = await onlineIds();
      for (const pl of players) {
        if (!online.has(steamOf(pl))) continue; // los comandos "online" esperan a que el jugador entre
        const oc = await tebex('GET', `/queue/online-commands/${encodeURIComponent(pl.id)}`);
        for (const c of oc?.commands || []) await exec(c, pl, 'online');
      }
    }
    state.pending = players.length;
    if (done.length) await tebex('DELETE', '/queue', { ids: done });
    for (const p of byPayment.values()) await recordPurchase(p);
    if (byPayment.size || done.length) save();
    state.status = 'ready'; state.error = null;
  } catch (e) {
    state.status = 'error'; state.error = errParam(e);
    if (e.code === 'store_rate_limited') next = 300;
  } finally {
    running = false;
    state.lastCheck = Date.now();
    schedule(next);
  }
  return view();
}

async function recordPurchase(p) {
  const rec = { ...p, packages: [...p.packages] };
  db.purchases.push(rec);
  db.totals.payments++; db.totals.commands += rec.commands.length;
  log('panel', L(rec.ok ? 'store_delivered' : 'store_failed', { name: rec.name || rec.steamid || '?', n: rec.commands.length }));
  audit.record({ user: 'tebex', action: 'store_delivery', target: rec.steamid || null, details: rec.commands.map(c => c.line).join(' | ').slice(0, 300), ok: rec.ok });
  bus.emit('store', { purchase: rec });
  const s = settings();
  if (!rec.ok) return;
  if (s.announce && rec.name && rcon.isConnected()) await moderation.say(tr(lang(), 'game.store_thanks', { name: rec.name }), 'Tebex').catch(() => {});
  const hook = s.discord && watch.discordWebhook();
  if (hook) {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Oxidian', allowed_mentions: { parse: [] }, embeds: [{ color: 0xE0A93B, title: tr(lang(), 'store.discordTitle'), description: tr(lang(), 'store.discordBody', { name: (rec.name || rec.steamid).replace(/([\\*_`~|>])/g, '\\$1'), n: rec.commands.length }) }] }) }).catch(() => {});
  }
}

function schedule(sec) {
  clearTimeout(timer);
  state.nextCheck = Date.now() + sec * 1000;
  timer = setTimeout(() => check().catch(() => {}), sec * 1000);
}

// ---------- Panel ----------
function view() {
  const s = settings();
  return {
    settings: { ...s, secret: undefined, hasSecret: !!s.secret, secretHint: s.secret ? '••••' + s.secret.slice(-4) : '' },
    state: { ...state, delayed: delayed.size },
    purchases: db.purchases.slice(-50).reverse(),
    totals: db.totals,
  };
}

async function test(secret) {
  const sec = String(secret || '').trim() || settings().secret;
  if (!sec) throw E('store_no_secret');
  const info = await tebex('GET', '/information', null, sec);
  return { account: { name: info?.account?.name || '', domain: info?.account?.domain || '', currency: info?.account?.currency?.iso_4217 || '' }, server: info?.server?.name || '' };
}

async function update(input = {}) {
  const cur = settings(), out = { ...cur };
  for (const k of ['enabled', 'announce', 'discord']) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.secret !== undefined && String(input.secret).trim()) {
    const sec = String(input.secret).trim();
    if (!/^[\w-]{20,80}$/.test(sec)) throw E('store_bad_secret_format');
    state.account = (await test(sec)).account; // solo se guarda si Tebex la acepta
    out.secret = sec;
  }
  if (input.clearSecret) { out.secret = ''; out.enabled = false; state.account = null; }
  config.update('store', out);
  if (out.enabled && out.secret) setTimeout(() => check().catch(() => {}), 1000);
  else { clearTimeout(timer); state.status = 'off'; state.nextCheck = null; }
  return view();
}

function start() {
  load();
  const s = settings();
  if (s.enabled && s.secret) {
    test().then(r => { state.account = r.account; }).catch(e => { state.status = 'error'; state.error = errParam(e); });
    schedule(20);
  }
  bus.on('rcon', ({ connected }) => { if (connected && settings().enabled) schedule(15); });
}

module.exports = { start, view, update, check, test, fill };
