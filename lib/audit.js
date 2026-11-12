// Registro de actividad: quién hizo qué y cuándo (solo acciones que cambian algo)
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'audit.json');
const MAX = 5000;
const SECRET = /pass|key|hash|secret|webhook|token/i;
const BULKY = /^(source|text)$/; // contenido de plugins y configuraciones: solo se guarda su tamaño

let entries = [];
try { entries = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { entries = []; }
let timer = null;
const save = () => { if (!timer) timer = setTimeout(() => { timer = null; fs.writeFileSync(FILE, JSON.stringify(entries)); }, 1500); };

// Resume el cuerpo de la petición sin datos sensibles
function summarize(body = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (SECRET.test(k)) { out[k] = v ? '••••' : ''; continue; }
    if (BULKY.test(k)) { out[k] = `${String(v || '').length} B`; continue; }
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { out[k] = v.length > 6 ? `[${v.length}]` : v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ').slice(0, 160); continue; }
    if (typeof v === 'object') { out[k] = JSON.stringify(v).slice(0, 160); continue; }
    out[k] = String(v).slice(0, 160);
  }
  return out;
}

function record({ user, action, target, details, ok, ip, denied = false }) {
  entries.unshift({ t: Date.now(), user, action, target: target || null, details, ok, ip, denied });
  if (entries.length > MAX) entries.length = MAX;
  save();
}

function list({ user, action, limit = 300 } = {}) {
  return entries.filter(e => (!user || e.user === user) && (!action || e.action === action)).slice(0, Math.min(1000, limit));
}

module.exports = { record, list, summarize };
