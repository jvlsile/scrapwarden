// Detección de VPN, proxy, Tor y centros de datos, y restricción por país.
// Usa un servicio externo de reputación de IP (proxycheck.io o ip-api.com) con caché de 3 días,
// así cada IP se consulta como mucho una vez cada pocos días.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { E } = require('./i18n');

const CACHE_FILE = path.join(config.DATA_DIR, 'ipcheck.json');
const CACHE_MS = 3 * 86400 * 1000;
const PROVIDERS = ['proxycheck', 'ipapi'];
const BASE = {
  proxycheck: process.env.PROXYCHECK_API_BASE || 'https://proxycheck.io/v2',
  ipapi: process.env.IPAPI_API_BASE || 'http://ip-api.com/json', // el plan gratuito de ip-api solo funciona por HTTP
};

const DEFAULTS = {
  enabled: false,
  provider: 'proxycheck',
  apiKey: '',                 // proxycheck: opcional (100 consultas/día sin clave, 1000 con clave gratuita)
  vpnMode: 'alert',           // VPN, proxy o Tor
  hostingMode: 'off',         // IP de un centro de datos (servidores, VPN "caseras")
  countryMode: 'off',
  countryList: 'block',       // block: los países de la lista no entran | allow: solo entran los de la lista
  countries: [],              // códigos ISO de 2 letras
  whitelist: [],              // SteamIDs que nunca se comprueban
};

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const now = Date.now();
    for (const [ip, r] of Object.entries(cache)) if (now - r.t > CACHE_MS * 4) delete cache[ip];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }, 1500);
}

const settings = () => ({ ...DEFAULTS, ...(config.get().ipcheck || {}) });

// IPs privadas o locales: no tiene sentido consultarlas
function isPrivate(ip) {
  return /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^(::1|fc|fd|fe80)/i.test(ip);
}
const validIp = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]{2,39}$/i.test(ip);

async function query(ip, s) {
  const opt = { headers: { 'User-Agent': 'Scrapwarden' }, signal: AbortSignal.timeout(8000) };
  if (s.provider === 'ipapi') {
    const res = await fetch(`${BASE.ipapi}/${encodeURIComponent(ip)}?fields=status,message,countryCode,isp,org,proxy,hosting`, opt);
    if (res.status === 429) throw E('ipcheck_limit');
    if (!res.ok) throw E('ipcheck_status', { status: res.status });
    const j = await res.json();
    if (j.status !== 'success') throw E('ipcheck_status', { status: j.message || 'fail' });
    return { proxy: !!j.proxy, vpn: !!j.proxy, tor: false, hosting: !!j.hosting, country: j.countryCode || null, provider: j.org || j.isp || null };
  }
  const qs = new URLSearchParams({ vpn: '3', asn: '1' });
  if (s.apiKey) qs.set('key', s.apiKey);
  const res = await fetch(`${BASE.proxycheck}/${encodeURIComponent(ip)}?${qs}`, opt);
  const j = await res.json().catch(() => null);
  if (!j) throw E('ipcheck_status', { status: res.status });
  if (j.status === 'denied') throw E(/limit|exhaust|quer/i.test(j.message || '') ? 'ipcheck_limit' : 'ipcheck_bad_key');
  if (j.status === 'error') throw E('ipcheck_status', { status: j.message || 'error' });
  const r = j[ip] || {};
  const type = String(r.type || '').toLowerCase();
  return {
    proxy: r.proxy === 'yes',
    vpn: r.vpn === 'yes' || type === 'vpn',
    tor: type === 'tor',
    hosting: type === 'hosting',
    country: r.isocode || null,
    provider: r.provider || r.organisation || null,
  };
}

async function lookup(ip, { force = false } = {}) {
  ip = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, ''); // IPv4 con puerto
  if (!validIp(ip)) throw E('ipcheck_bad_ip');
  if (isPrivate(ip)) return { ip, private: true, proxy: false, vpn: false, tor: false, hosting: false, country: null, provider: null, t: Date.now() };
  const c = cache[ip];
  if (!force && c && Date.now() - c.t < CACHE_MS) return c;
  const r = { ip, ...(await query(ip, settings())), t: Date.now() };
  cache[ip] = r;
  save();
  return r;
}

// Reglas: devuelve los hallazgos (con la acción configurada)
function evaluate(r) {
  const s = settings(), out = [];
  if (!r || r.private) return out;
  if (s.vpnMode !== 'off' && (r.vpn || r.proxy || r.tor)) {
    out.push({ code: 'ip_vpn', severity: 'medium', mode: s.vpnMode, params: { kind: r.tor ? 'Tor' : r.vpn ? 'VPN' : 'Proxy', provider: r.provider || '—', country: r.country || '—' } });
  } else if (s.hostingMode !== 'off' && r.hosting) {
    out.push({ code: 'ip_hosting', severity: 'low', mode: s.hostingMode, params: { provider: r.provider || '—', country: r.country || '—' } });
  }
  if (s.countryMode !== 'off' && r.country && s.countries.length) {
    const inList = s.countries.includes(r.country.toUpperCase());
    if ((s.countryList === 'block' && inList) || (s.countryList === 'allow' && !inList)) {
      out.push({ code: 'ip_country', severity: 'low', mode: s.countryMode, params: { country: r.country } });
    }
  }
  return out;
}

const isWhitelisted = (id) => (settings().whitelist || []).includes(String(id));

function update(v) {
  const clean = { ...settings() };
  const mode = (x) => (['off', 'alert', 'kick'].includes(x) ? x : 'off');
  if ('enabled' in v) clean.enabled = !!v.enabled;
  if ('provider' in v) clean.provider = PROVIDERS.includes(v.provider) ? v.provider : 'proxycheck';
  if (v.apiKey) {
    const k = String(v.apiKey).trim();
    if (!/^[\w-]{10,64}$/.test(k)) throw E('ipcheck_key_format');
    clean.apiKey = k;
  }
  if (v.clearKey) clean.apiKey = '';
  for (const k of ['vpnMode', 'hostingMode', 'countryMode']) if (k in v) clean[k] = mode(v[k]);
  if ('countryList' in v) clean.countryList = v.countryList === 'allow' ? 'allow' : 'block';
  if ('countries' in v) clean.countries = [...new Set(String(Array.isArray(v.countries) ? v.countries.join(',') : v.countries).toUpperCase().match(/\b[A-Z]{2}\b/g) || [])].slice(0, 250);
  if (clean.countryMode !== 'off' && clean.countryList === 'allow' && !clean.countries.length) throw E('ipcheck_no_countries');
  if ('whitelist' in v) clean.whitelist = [...new Set(String(Array.isArray(v.whitelist) ? v.whitelist.join('\n') : v.whitelist).match(/\b7656\d{13}\b/g) || [])];
  config.update('ipcheck', clean);
  return publicSettings();
}

function publicSettings() {
  const s = settings();
  return { ...s, apiKey: '', hasKey: !!s.apiKey, keyHint: s.apiKey ? '••••' + s.apiKey.slice(-4) : '' };
}

module.exports = { lookup, evaluate, isWhitelisted, update, publicSettings, settings, isPrivate, DEFAULTS };
