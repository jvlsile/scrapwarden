// Traducciones compartidas entre interfaz y servidor.
// Los diccionarios viven en public/i18n/<idioma>.json ({ meta, strings, wiki }).
// El backend envía códigos ({ k, p }) y la interfaz los traduce al idioma de cada usuario.
// Solo se traduce aquí lo que sale del panel sin pasar por la interfaz: chat del juego y Discord.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');
const DEFAULT = 'es';
const cache = {};

function available() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    return { code: j.meta.code, name: j.meta.name };
  });
}

function dict(lang) {
  if (!cache[lang]) {
    try { cache[lang] = JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8')).strings; }
    catch { cache[lang] = {}; }
  }
  return cache[lang];
}

// Traduce una clave; los parámetros pueden ser a su vez { k, p } (se traducen recursivamente)
function tr(lang, key, params = {}) {
  const s = dict(lang)[key] ?? dict(DEFAULT)[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    if (v === undefined || v === null) return m;
    if (typeof v === 'object' && v.k) return tr(lang, v.k, v.p || {});
    return String(v);
  });
}

// Error con código traducible. message queda en español para los registros del sistema.
class PanelError extends Error {
  constructor(code, params = {}) {
    super(tr(DEFAULT, 'err.' + code, params));
    this.code = code;
    this.params = params;
  }
}
const E = (code, params) => new PanelError(code, params);

// Mensaje de registro traducible
const L = (k, p = {}) => ({ k: 'log.' + k, p });

// Convierte un error cualquiera en parámetro traducible
const errParam = (e) => (e && e.code ? { k: 'err.' + e.code, p: e.params || {} } : String(e?.message || e));

module.exports = { tr, E, L, errParam, available, DEFAULT, PanelError };
