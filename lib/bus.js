// Bus de eventos compartido: logs de consola, progreso del instalador, estado
const { EventEmitter } = require('events');
const { tr } = require('./i18n');

const bus = new EventEmitter();
bus.setMaxListeners(100);

const consoleBuffer = [];
const MAX_LINES = 1000;

// line puede ser texto (salida del servidor, SteamCMD) o { k, p } (mensaje del panel traducible)
function log(source, line) {
  const entry = { t: Date.now(), source };
  if (line && typeof line === 'object' && line.k) {
    entry.k = line.k;
    entry.p = line.p;
    entry.line = tr('es', line.k, line.p);
  } else {
    entry.line = String(line).replace(/\r/g, '');
  }
  consoleBuffer.push(entry);
  if (consoleBuffer.length > MAX_LINES) consoleBuffer.shift();
  bus.emit('console', entry);
}

module.exports = { bus, log, consoleBuffer };
