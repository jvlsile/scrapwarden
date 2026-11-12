// Mapa en vivo: imagen del mapa (renderizada por el servidor y guardada en caché) y posiciones
const fs = require('fs');
const path = require('path');
const config = require('./config');
const watch = require('./watch');
const { E } = require('./i18n');

const DIR = path.join(config.DATA_DIR, 'map');

function metaFile() {
  const s = config.get().server;
  return path.join(DIR, `${s.identity}.json`);
}

function cachedMeta() {
  try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return null; }
}

// Pide al servidor la imagen del mapa (tarda unos segundos) y la guarda
async function render() {
  // Comprueba en el momento por si el panel acaba de reconectar y aún no lo había verificado
  if (!watch.isBridgeLoaded() && !(await watch.checkBridge())) throw E('bridge_missing');
  const d = await watch.rconJson('oxidian.map', 120000);
  const buf = Buffer.from(d.image, 'base64');
  const ext = buf[0] === 0x89 ? 'png' : 'jpg';
  fs.mkdirSync(DIR, { recursive: true });
  const s = config.get().server;
  const imageFile = `${s.identity}.${ext}`;
  fs.writeFileSync(path.join(DIR, imageFile), buf);
  // scale y oceanMargin vienen del complemento desde la 1.3.1; los mapas guardados antes se regeneran (ver geomVersion)
  const meta = { width: d.width, height: d.height, worldSize: d.worldSize, seed: d.seed, scale: d.scale ?? 0.5, oceanMargin: d.oceanMargin ?? 500, geomVersion: 3, monuments: d.monuments || [], paths: d.paths || null, imageFile, renderedAt: Date.now() };
  fs.writeFileSync(metaFile(), JSON.stringify(meta));
  return meta;
}

// Devuelve los datos del mapa; si el mundo ha cambiado (wipe, semilla, tamaño) lo vuelve a generar
async function meta({ refresh = false } = {}) {
  const s = config.get().server;
  const m = cachedMeta();
  // Mapa guardado sin rutas pero el complemento ya las envía (se actualizó después): se vuelve a pedir
  const bv = (watch.bridgeInfo().version || '0').split('.').map(Number);
  const bridgeHasPaths = bv[0] > 1 || (bv[0] === 1 && bv[1] >= 5);
  const stale = !m || m.geomVersion !== 3 || (!m.paths && bridgeHasPaths) || m.worldSize !== s.worldSize || (m.seed && String(m.seed) !== String(s.seed) && ['Procedural Map', 'Barren'].includes(s.level));
  if (refresh || stale) {
    try { return await render(); } catch (e) { if (m && !refresh) return { ...m, stale: true }; throw e; }
  }
  return m;
}

function imagePath() {
  const m = cachedMeta();
  if (!m) throw E('map_not_ready');
  return path.join(DIR, m.imageFile);
}

const positions = () => watch.rconJson('oxidian.positions', 8000);

function imagePathSafe() { try { return imagePath(); } catch { return null; } }

module.exports = { meta, imagePath, imagePathSafe, positions, cached: cachedMeta };
