// Cliente WebRCON de Rust (ws://host:puerto/contraseña)
const WebSocket = require('ws');
const config = require('./config');
const { bus, log } = require('./bus');
const { E, L } = require('./i18n');

let ws = null;
let connected = false;
let nextId = 1000;
const pending = new Map();
let reconnectTimer = null;
let wanted = false;
let consoleViaRcon = false; // lo activa server.js cuando el proceso no es del panel

function connect() {
  wanted = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const t = config.rconTarget();
  if (!t.host || !t.password) { connected = false; return; }
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host; // IPv6
  const url = `ws://${host}:${t.port}/${encodeURIComponent(t.password)}`;
  ws = new WebSocket(url, { handshakeTimeout: config.isRemote() ? 8000 : 5000 });

  ws.on('open', () => {
    connected = true;
    bus.emit('rcon', { connected: true });
    log('panel', L('rcon_connected'));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const id = msg.Identifier;
    if (pending.has(id)) {
      const p = pending.get(id);
      const text = String(msg.Message ?? '');
      // Rust envía con el mismo identificador cualquier línea de log emitida mientras corre el comando
      // (p. ej. el aviso de Oxide «Calling 'X' on 'Y' took 2268ms»), a veces antes de la respuesta real.
      // Esas líneas se registran y se sigue esperando.
      if (isLogNoise(text) || (p.expectJson && !looksJson(text) && !NOT_FOUND.test(text))) {
        if (text.trim()) for (const l of text.split(/\r?\n/)) if (l.trim()) { log('server', l); bus.emit('serverline', l); }
        return;
      }
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(msg.Message);
    } else if (id === 0 || id === -1 || id === undefined) {
      // Mensajes del servidor sin solicitud (logs, chat)
      const text = String(msg.Message || '');
      const bi = text.indexOf('RPANEL|');
      if (bi !== -1) {
        try { bus.emit('bridge', JSON.parse(text.slice(bi + 7).trim())); } catch {}
        return;
      }
      if (msg.Type === 'Chat') {
        try {
          const c = JSON.parse(msg.Message);
          log('chat', `${c.Username}: ${c.Message}`);
          bus.emit('chat', c);
        } catch { log('chat', msg.Message); }
      } else if (text.trim() && consoleViaRcon) {
        // Servidor que no arrancó el panel (remoto o ya encendido): su consola llega por RCON
        for (const l of text.split(/\r?\n/)) if (l.trim()) { log('server', l); bus.emit('serverline', l); }
      }
    }
  });

  const onClose = () => {
    if (connected) log('panel', L('rcon_disconnected'));
    connected = false;
    bus.emit('rcon', { connected: false });
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(E('rcon_disconnected')); }
    pending.clear();
    if (wanted && !reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wanted) connect(); }, config.isRemote() ? 10000 : 5000);
    }
  };
  ws.on('close', onClose);
  ws.on('error', () => { /* se gestiona en close */ });
}

function disconnect() {
  wanted = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.terminate(); } catch {} }
  ws = null;
  connected = false;
}

// Avisos de Oxide/Carbon por hooks o comandos lentos: nunca son la respuesta de un comando
const NOISE = /^\s*(\[[^\]]*\]\s*)*(Calling '[^']+' on '[^']+' took \d+(\.\d+)?\s*ms|\S+ took \d+(\.\d+)?\s*ms (to|in) )/i;
// Respuesta de Rust cuando el comando no existe (complemento no cargado): sí es la respuesta
const NOT_FOUND = /command not found|unknown command|invalid command|no such command/i;
function isLogNoise(text) { return NOISE.test(text); }
function looksJson(text) { const t = text.trim(); return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')); }

function command(cmd, timeoutMs = 10000, expectJson = false) {
  return new Promise((resolve, reject) => {
    if (!connected || !ws) return reject(E('rcon_not_connected'));
    const id = nextId++;
    if (nextId > 2_000_000_000) nextId = 1000;
    const timer = setTimeout(() => { pending.delete(id); reject(E('rcon_timeout')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, expectJson });
    ws.send(JSON.stringify({ Identifier: id, Message: cmd, Name: 'Scrapwarden' }));
  });
}

async function json(cmd, timeoutMs) {
  const out = await command(cmd, timeoutMs, true);
  try { return JSON.parse(out); } catch { return null; }
}

// Mensaje al chat global con escape básico de comillas
function say(message) {
  return command(`say "${String(message).replace(/"/g, "'")}"`);
}

// Prueba unas credenciales sin tocar la conexión principal (para el asistente de modo remoto e importar)
function probe({ host, port, password }, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const h = String(host || '').includes(':') && !String(host).startsWith('[') ? `[${host}]` : host;
    let done = false, sock;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { sock.terminate(); } catch {} resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    try { sock = new WebSocket(`ws://${h}:${port}/${encodeURIComponent(password)}`, { handshakeTimeout: timeoutMs }); }
    catch (e) { return finish({ ok: false, error: 'bad_address' }); }
    sock.on('open', () => sock.send(JSON.stringify({ Identifier: 1, Message: 'serverinfo', Name: 'Scrapwarden' })));
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.Identifier !== 1) return;
      let info = null; try { info = JSON.parse(m.Message); } catch {}
      finish({ ok: true, info });
    });
    sock.on('unexpected-response', () => finish({ ok: false, error: 'auth' })); // el servidor rechaza la contraseña
    sock.on('error', (e) => finish({ ok: false, error: /ECONNREFUSED/.test(e.message) ? 'refused' : /ENOTFOUND|EAI_AGAIN/.test(e.message) ? 'not_found' : 'unreachable' }));
    sock.on('close', () => finish({ ok: false, error: 'auth' })); // Rust cierra la conexión si la contraseña es incorrecta
  });
}

function setConsoleViaRcon(on) { consoleViaRcon = !!on; }

module.exports = { connect, disconnect, command, json, say, probe, setConsoleViaRcon, isConnected: () => connected, isWanted: () => wanted };
