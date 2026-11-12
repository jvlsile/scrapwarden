// Control del mundo: hora del día, clima y eventos (carguero, helicóptero, lanzamiento aéreo, Chinook)
const rcon = require('./rcon');
const watch = require('./watch');
const { log } = require('./bus');
const { E, L } = require('./i18n');

const TIMES = { dawn: 6.5, noon: 12, dusk: 19, night: 0 };
const WEATHER = {
  clear: { 'weather.rain': 0, 'weather.fog': 0, 'weather.clouds': 0, 'weather.wind': 0.1, 'weather.thunder': 0 },
  rain: { 'weather.rain': 1, 'weather.clouds': 0.85, 'weather.fog': 0.1, 'weather.wind': 0.4, 'weather.thunder': 0 },
  storm: { 'weather.rain': 1, 'weather.clouds': 1, 'weather.fog': 0.3, 'weather.wind': 1, 'weather.thunder': 1 },
  fog: { 'weather.rain': 0, 'weather.clouds': 0.4, 'weather.fog': 1, 'weather.wind': 0 },
  // -1 = sin forzar: Rust vuelve a su clima automático
  auto: { 'weather.rain': -1, 'weather.fog': -1, 'weather.clouds': -1, 'weather.wind': -1, 'weather.thunder': -1 },
};
const EVENTS = ['cargo', 'heli', 'airdrop', 'chinook'];

const needRcon = () => { if (!rcon.isConnected()) throw E('rcon_not_connected'); };
const parseNum = (out) => { const m = String(out || '').match(/-?\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : null; };
const parseBool = (out) => /true/i.test(String(out || '')) ? true : /false/i.test(String(out || '')) ? false : null;

async function view() {
  if (!rcon.isConnected()) return { online: false, bridge: false };
  const [time, prog] = await Promise.all([
    rcon.command('env.time', 4000).catch(() => ''),
    rcon.command('env.progresstime', 4000).catch(() => ''),
  ]);
  return { online: true, bridge: !!watch.isBridgeLoaded(), hour: parseNum(time), frozen: parseBool(prog) === false };
}

async function setTime({ preset, hour, freeze }) {
  needRcon();
  if (preset !== undefined || hour !== undefined) {
    const h = preset !== undefined ? TIMES[preset] : Number(hour);
    if (h === undefined || !Number.isFinite(h) || h < 0 || h >= 24) throw E('bad_time');
    await rcon.command(`env.time ${h}`);
    log('panel', L('world_time', { h: String(h).replace('.5', ':30').replace(/^(\d+)$/, '$1:00') }));
  }
  if (freeze !== undefined) {
    await rcon.command(`env.progresstime ${freeze ? 'false' : 'true'}`);
    log('panel', L(freeze ? 'world_frozen' : 'world_unfrozen'));
  }
  return view();
}

async function setWeather(preset) {
  needRcon();
  const w = WEATHER[preset];
  if (!w) throw E('bad_weather');
  for (const [k, v] of Object.entries(w)) await rcon.command(`${k} ${v}`).catch(() => {});
  log('panel', L('world_weather', { w: { k: 'wd.w.' + preset } }));
  return { ok: true, preset };
}

async function startEvent(type) {
  needRcon();
  if (!EVENTS.includes(type)) throw E('bad_event');
  if (!watch.isBridgeLoaded()) throw E('bridge_missing');
  await watch.rconJson(`scrapwarden.event ${type}`, 8000);
  log('panel', L('world_event', { e: { k: 'wd.e.' + type } }));
  return { ok: true, type };
}

module.exports = { view, setTime, setWeather, startEvent, TIMES, WEATHER, EVENTS };
