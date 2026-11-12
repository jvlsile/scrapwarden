// Web pública del servidor: página sin login para los jugadores (estado, conectar, wipe, rates, mapa, actividad, rankings, normas).
// Solo expone datos pensados para ser públicos: nunca posiciones en vivo, IP, SteamID ni nada de moderación.
const fs = require('fs');
const config = require('./config');
const server = require('./server');
const rcon = require('./rcon');
const watch = require('./watch');
const stats = require('./stats');
const wipes = require('./wipes');
const rates = require('./rates');
const liveMap = require('./map');
const { E } = require('./i18n');

const DEFAULTS = {
  enabled: false,
  address: '',             // dirección pública para conectar (ip o dominio[:puerto]); vacío = la del navegador
  tagline: '',
  description: '',
  rules: [],               // una norma por elemento
  links: { discord: '', store: '', website: '', steam: '' },
  accent: '#5BB5A2',
  lang: 'auto',            // auto | es | en | pt | fr
  showMap: true,
  showChart: true,
  showRankings: true,
  showPlayers: false,      // lista de nombres conectados (desactivado por privacidad)
};

const settings = () => {
  const s = { ...DEFAULTS, ...(config.get().public || {}) };
  s.links = { ...DEFAULTS.links, ...(s.links || {}) };
  return s;
};

const cleanUrl = (u) => {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) throw E('bad_public_link');
  return u.slice(0, 300);
};

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  for (const k of ['showMap', 'showChart', 'showRankings', 'showPlayers']) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.address !== undefined) {
    const a = String(input.address || '').trim();
    if (a && !/^[\w.-]+(:\d{2,5})?$/.test(a)) throw E('bad_public_address');
    out.address = a;
  }
  if (input.tagline !== undefined) out.tagline = String(input.tagline || '').slice(0, 140);
  if (input.description !== undefined) out.description = String(input.description || '').slice(0, 2000);
  if (input.rules !== undefined) out.rules = (Array.isArray(input.rules) ? input.rules : String(input.rules).split('\n')).map(r => String(r).trim()).filter(Boolean).slice(0, 30).map(r => r.slice(0, 300));
  if (input.links) out.links = { discord: cleanUrl(input.links.discord), store: cleanUrl(input.links.store), website: cleanUrl(input.links.website), steam: cleanUrl(input.links.steam) };
  if (input.accent !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(input.accent)) throw E('bad_public_accent'); out.accent = input.accent; }
  if (input.lang !== undefined && ['auto', 'es', 'en', 'pt', 'fr'].includes(input.lang)) out.lang = input.lang;
  config.update('public', out);
  cache = null;
  return settings();
}

// ---------- Datos públicos (con caché corta para que una visita masiva no cargue el servidor) ----------
let cache = null, cacheAt = 0;

async function data() {
  const s = settings();
  if (!s.enabled) throw E('public_disabled');
  if (cache && Date.now() - cacheAt < 15000) return cache;
  const cfg = config.get().server;
  const st = server.getStatus();
  let info = null;
  if (rcon.isConnected()) info = await rcon.json('serverinfo', 5000).catch(() => null);
  const online = st.status === 'running' && !!info;
  let players = [];
  if (online && s.showPlayers) {
    const list = await rcon.json('playerlist', 5000).catch(() => []);
    players = (Array.isArray(list) ? list : []).map(p => String(p.DisplayName || '').slice(0, 40)).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }
  const r = rates.view();
  const w = wipes.view();
  const nextWipe = wipes.next() || (w.forced[0] ? { at: w.forced[0], forced: true, bp: w.settings.bp !== 'never' } : null);
  const lastWipe = [...(w.history || [])].find(h => h.ok);
  const q = stats.query('7d');
  // Actividad: media de jugadores por hora (últimos 7 días), sin nombres
  const series = q.series.map(x => [x[0], x[1]]);
  let mapInfo = null;
  if (s.showMap) {
    const m = liveMap.cached();
    if (m && fs.existsSync(liveMap.imagePathSafe() || '')) mapInfo = { width: m.width, height: m.height, worldSize: m.worldSize, oceanMargin: m.oceanMargin ?? 500, scale: m.scale ?? 0.5, monuments: m.monuments || [], paths: m.paths || null, v: m.renderedAt };
  }
  cache = {
    t: Date.now(),
    settings: { tagline: s.tagline, description: s.description, rules: s.rules, links: s.links, accent: s.accent, lang: s.lang, showChart: s.showChart, showRankings: s.showRankings, showPlayers: s.showPlayers },
    server: {
      name: info?.Hostname || cfg.hostname, online, status: st.status,
      players: info ? info.Players | 0 : 0, maxPlayers: info ? info.MaxPlayers | 0 : cfg.maxplayers, queued: info ? info.Queued | 0 : 0,
      uptimeSince: online ? st.startedAt : null,
      level: cfg.level, worldSize: cfg.worldsize,
      address: s.address || null, port: cfg.port,
      pve: !!cfg.pve, teamLimit: (watch.status().settings || {}).teamLimit || 0,
      rates: { gather: r.rates.gather, pickup: r.rates.pickup, quarry: r.rates.quarry, craft: r.rates.craft },
      framework: cfg.framework,
    },
    wipe: {
      next: nextWipe ? { at: nextWipe.at, forced: !!nextWipe.forced, bp: !!nextWipe.bp } : null,
      schedule: w.settings.enabled ? w.settings.schedule : 'forced',
      weekday: w.settings.weekday, time: w.settings.time,
      last: lastWipe ? lastWipe.t : (q.wipeStart || null),
    },
    stats: { peak: q.summary.peak.n, avg: q.summary.avg, uniques: q.summary.uniques, series: s.showChart ? series : [] },
    rankings: s.showRankings ? {
      play: q.topPlay.slice(0, 5).map(p => ({ name: p.name, hours: p.hours })),
      kills: q.topKills.slice(0, 5).map(p => ({ name: p.name, kills: p.kills, kd: p.kd })),
    } : null,
    playersList: players,
    map: mapInfo,
  };
  cacheAt = Date.now();
  return cache;
}

function mapImage() {
  const s = settings();
  if (!s.enabled || !s.showMap) throw E('public_disabled');
  return liveMap.imagePath();
}

module.exports = { settings, update, data, mapImage, DEFAULTS };
