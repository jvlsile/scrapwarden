// Rates y modo de juego: multiplicadores de recolección y crafteo (con el complemento OxidianBridge),
// ajustes de vanilla (decay, radiación, cajas bloqueadas…) y cambio PvP/PvE al momento.
const config = require('./config');
const rcon = require('./rcon');
const watch = require('./watch');
const { bus, log } = require('./bus');
const { E, L, tr } = require('./i18n');

const DEFAULTS = {
  // Multiplicadores (los aplica el complemento; 1 = vanilla)
  gather: 1,      // árboles, piedras y menas, animales
  pickup: 1,      // recogida del suelo y cultivos
  quarry: 1,      // canteras, excavadora y cargas de prospección
  craft: 1,       // velocidad de crafteo (2 = el doble de rápido)
  // Ajustes de vanilla (variables del servidor, sin complemento)
  decayScale: 1,          // decay.scale (0 = sin deterioro)
  upkeep: true,           // decay.upkeep
  radiation: true,        // server.radiation
  stability: true,        // server.stability
  crateSeconds: 900,      // hackablelockedcrate.requiredhackseconds
  announce: true,         // avisar en el chat al cambiar el modo o los rates
};
const LIMITS = { gather: [0.1, 100], pickup: [0.1, 100], quarry: [0.1, 100], craft: [0.1, 100], decayScale: [0, 10], crateSeconds: [0, 3600] };
const BOOLS = ['upkeep', 'radiation', 'stability', 'announce'];

function current() {
  return { ...DEFAULTS, ...(config.get().rates || {}) };
}

function view() {
  const st = rcon.isConnected ? rcon.isConnected() : false;
  return {
    rates: current(),
    pve: !!config.get().server.pve,
    framework: config.get().server.framework,
    bridge: !!watch.isBridgeLoaded(),
    bridgeInfo: watch.bridgeInfo(),
    online: !!st,
    limits: LIMITS,
  };
}

const num = (v, [lo, hi], def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
};

function sanitize(input) {
  const cur = current(), out = { ...cur };
  for (const k of Object.keys(LIMITS)) if (input[k] !== undefined) out[k] = num(input[k], LIMITS[k], cur[k]);
  out.crateSeconds = Math.round(out.crateSeconds);
  for (const k of BOOLS) if (input[k] !== undefined) out[k] = !!input[k];
  return out;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));
const lang = () => config.get().panel.notifyLang || 'es';

// Envía todo al servidor. Devuelve qué se pudo aplicar.
async function apply() {
  const r = current();
  const res = { vanilla: false, multipliers: false };
  if (!(rcon.isConnected && rcon.isConnected())) return res;
  const cmds = [
    `decay.scale ${r.decayScale}`,
    `decay.upkeep ${r.upkeep}`,
    `server.radiation ${r.radiation}`,
    `server.stability ${r.stability}`,
    `hackablelockedcrate.requiredhackseconds ${r.crateSeconds}`,
  ];
  for (const c of cmds) await rcon.command(c).catch(() => {});
  await rcon.command('server.writecfg').catch(() => {});
  res.vanilla = true;
  if (watch.isBridgeLoaded()) {
    const payload = Buffer.from(JSON.stringify({ gather: r.gather, pickup: r.pickup, quarry: r.quarry, craft: r.craft })).toString('base64');
    const out = await watch.rconJson(`oxidian.rates ${payload}`, 8000).catch(() => null);
    res.multipliers = !!(out && out.ok);
  }
  return res;
}

async function update(input) {
  const before = current();
  const next = sanitize(input || {});
  config.update('rates', next);
  const res = await apply();
  const changedMult = ['gather', 'pickup', 'quarry', 'craft'].some(k => before[k] !== next[k]);
  log('panel', L('rates_saved', { g: fmt(next.gather), p: fmt(next.pickup), q: fmt(next.quarry), c: fmt(next.craft) }));
  if (changedMult && next.announce && res.multipliers) {
    await rcon.say(tr(lang(), 'game.rates_changed', { g: fmt(next.gather), p: fmt(next.pickup), q: fmt(next.quarry), c: fmt(next.craft) })).catch(() => {});
  }
  return { ...view(), applied: res };
}

// PvP / PvE en un clic: se aplica al momento por RCON y se guarda para los siguientes arranques
async function setMode(pve) {
  pve = !!pve;
  config.update('server', { pve });
  let live = false;
  if (rcon.isConnected && rcon.isConnected()) {
    await rcon.command(`server.pve ${pve}`);
    await rcon.command('server.writecfg').catch(() => {});
    live = true;
    if (current().announce) await rcon.say(tr(lang(), pve ? 'game.mode_pve' : 'game.mode_pvp')).catch(() => {});
  }
  log('panel', L(pve ? 'mode_pve' : 'mode_pvp'));
  return { ...view(), live };
}

function start() {
  // Rust no recuerda los multiplicadores del complemento ni todas las variables al reiniciar: se reaplican al conectar
  bus.on('rcon', ({ connected }) => { if (connected) setTimeout(() => apply().catch(() => {}), 8000); });
}

module.exports = { start, view, update, setMode, apply, DEFAULTS };
