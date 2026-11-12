// Comprobación de perfiles con la API web de Steam: baneos VAC y de juego, antigüedad de la cuenta,
// perfil privado y horas jugadas en Rust. Los resultados se guardan en caché 24 h.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { E } = require('./i18n');

const API = process.env.STEAM_API_BASE || 'https://api.steampowered.com';
const RUST_APPID = 252490;
const CACHE_FILE = path.join(config.DATA_DIR, 'steam.json');
const CACHE_MS = 24 * 3600 * 1000;

const DEFAULTS = {
  enabled: false,
  apiKey: '',
  vacDays: 365, vacMode: 'alert',        // baneo VAC o de juego en los últimos N días
  newDays: 30, newMode: 'alert',         // cuenta creada hace menos de N días
  privateMode: 'off',                    // perfil privado
  minHours: 10, hoursMode: 'off',        // menos de N horas en Rust (si son visibles)
  communityMode: 'alert',                // baneo de la comunidad de Steam
  whitelist: [],                         // SteamIDs que nunca se comprueban
};

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); }, 1500);
}

const settings = () => ({ ...DEFAULTS, ...(config.get().steam || {}) });

async function call(endpoint, params) {
  const key = settings().apiKey;
  if (!key) throw E('steam_no_key');
  const qs = new URLSearchParams({ key, ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`, { headers: { 'User-Agent': 'Scrapwarden/1.0' } });
  if (res.status === 403 || res.status === 401) throw E('steam_bad_key');
  if (!res.ok) throw E('steam_status', { status: res.status });
  return res.json();
}

// Devuelve el perfil (de caché si es reciente)
async function profile(steamid, { force = false } = {}) {
  const c = cache[steamid];
  if (!force && c && Date.now() - c.checkedAt < CACHE_MS) return c;
  const [bans, sums] = await Promise.all([
    call('ISteamUser/GetPlayerBans/v1/', { steamids: steamid }),
    call('ISteamUser/GetPlayerSummaries/v2/', { steamids: steamid }),
  ]);
  const b = bans.players?.[0] || {};
  const s = sums.response?.players?.[0] || {};
  const p = {
    steamid,
    name: s.personaname || null,
    avatar: s.avatarmedium || null,
    url: s.profileurl || `https://steamcommunity.com/profiles/${steamid}`,
    public: s.communityvisibilitystate === 3,
    created: s.timecreated ? s.timecreated * 1000 : null,
    vacBans: b.NumberOfVACBans || 0,
    gameBans: b.NumberOfGameBans || 0,
    daysSinceBan: (b.NumberOfVACBans || b.NumberOfGameBans) ? b.DaysSinceLastBan : null,
    communityBanned: !!b.CommunityBanned,
    rustHours: null,
    checkedAt: Date.now(),
  };
  // Horas en Rust: solo si los detalles de juegos son públicos
  if (p.public) {
    try {
      const g = await call('IPlayerService/GetOwnedGames/v1/', { steamid, include_played_free_games: 1, 'appids_filter[0]': RUST_APPID });
      const game = g.response?.games?.find(x => x.appid === RUST_APPID);
      if (game) p.rustHours = Math.round(game.playtime_forever / 60);
    } catch {}
  }
  cache[steamid] = p;
  save();
  return p;
}

// Aplica las reglas a un perfil y devuelve los hallazgos
function evaluate(p) {
  const s = settings();
  const out = [];
  const ageDays = p.created ? Math.floor((Date.now() - p.created) / 86400000) : null;
  if (s.vacMode !== 'off' && p.daysSinceBan !== null && p.daysSinceBan <= s.vacDays) {
    out.push({ code: 'steam_ban', severity: 'high', mode: s.vacMode, params: { vac: p.vacBans, game: p.gameBans, days: p.daysSinceBan } });
  }
  if (s.communityMode !== 'off' && p.communityBanned) out.push({ code: 'steam_community', severity: 'medium', mode: s.communityMode, params: {} });
  if (s.newMode !== 'off' && ageDays !== null && ageDays < s.newDays) {
    out.push({ code: 'steam_new', severity: 'medium', mode: s.newMode, params: { days: ageDays, limit: s.newDays } });
  }
  if (s.privateMode !== 'off' && !p.public) out.push({ code: 'steam_private', severity: 'low', mode: s.privateMode, params: {} });
  if (s.hoursMode !== 'off' && p.rustHours !== null && p.rustHours < s.minHours) {
    out.push({ code: 'steam_hours', severity: 'low', mode: s.hoursMode, params: { h: p.rustHours, limit: s.minHours } });
  }
  return out;
}

const isWhitelisted = (id) => (settings().whitelist || []).includes(String(id));
const cached = (id) => cache[id] || null;

function update(v) {
  const clean = { ...settings() };
  const mode = (x) => (['off', 'alert', 'kick'].includes(x) ? x : 'off');
  const int = (x, d, min, max) => { const n = parseInt(x, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  if ('enabled' in v) clean.enabled = !!v.enabled;
  // La clave nunca se envía a la interfaz: solo se cambia si llega una nueva o se pide borrarla
  if (v.apiKey) {
    const k = String(v.apiKey).trim();
    if (!/^[A-F0-9]{32}$/i.test(k)) throw E('steam_key_format');
    clean.apiKey = k;
  }
  if (v.clearKey) clean.apiKey = '';
  clean.vacDays = int(v.vacDays, clean.vacDays, 1, 10000);
  clean.newDays = int(v.newDays, clean.newDays, 1, 3650);
  clean.minHours = int(v.minHours, clean.minHours, 1, 10000);
  for (const k of ['vacMode', 'newMode', 'privateMode', 'hoursMode', 'communityMode']) if (k in v) clean[k] = mode(v[k]);
  if ('whitelist' in v) clean.whitelist = [...new Set(String(Array.isArray(v.whitelist) ? v.whitelist.join('\n') : v.whitelist).match(/\b7656\d{13}\b/g) || [])];
  config.update('steam', clean);
  return publicSettings();
}

// Nunca se devuelve la clave completa a la interfaz
function publicSettings() {
  const s = settings();
  return { ...s, apiKey: '', hasKey: !!s.apiKey, keyHint: s.apiKey ? '••••' + s.apiKey.slice(-4) : '' };
}

module.exports = { profile, evaluate, isWhitelisted, cached, update, publicSettings, settings, DEFAULTS };
