// Control del proceso RustDedicated: arranque, parada, reinicio, estado y recursos
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('./config');
const rcon = require('./rcon');
const { bus, log } = require('./bus');
const { E, L, errParam } = require('./i18n');

let proc = null;
let status = 'stopped'; // stopped | starting | running | stopping
let startedAt = null;
let expectedExit = false;
let crashCount = 0;
let lastCpu = null;
let winStats = null;       // métricas cacheadas en Windows
let logTail = null;        // lector del archivo de log (Windows)
let attached = false;      // servidor encendido que no arrancó el panel (modo remoto, o local ya en marcha)
let stoppingAttached = false;

function setStatus(s) {
  status = s;
  bus.emit('status', getStatus());
}

function getStatus() {
  const remote = config.isRemote();
  return {
    status,
    mode: remote ? 'remote' : 'local',
    managed: !!proc,
    attached,
    remoteHost: remote ? config.get().remote.host : null,
    remoteFiles: remote ? require('./files').available() : false,
    pid: proc?.pid || null,
    startedAt,
    installed: remote ? true : fs.existsSync(config.serverPaths().exe),
    framework: config.get().server.framework,
    pve: !!config.get().server.pve,
    gatherRate: (config.get().rates || {}).gather || 1,
    rcon: rcon.isConnected(),
  };
}

function buildArgs() {
  const s = config.get().server;
  const args = [
    '-batchmode', '-nographics',
    '+server.ip', '0.0.0.0',
    '+server.port', String(s.port),
    '+server.queryport', String(s.queryPort),
    '+rcon.ip', '0.0.0.0',
    '+rcon.port', String(s.rconPort),
    '+rcon.password', s.rconPassword,
    '+rcon.web', '1',
    '+app.port', String(s.appPort),
    '+server.identity', s.identity,
    '+server.hostname', s.hostname,
    '+server.description', s.description,
    '+server.maxplayers', String(s.maxplayers),
    '+server.level', s.level,
    '+server.saveinterval', String(s.saveinterval),
    '+server.tickrate', String(s.tickrate),
    '+server.pve', s.pve ? 'true' : 'false',
  ];
  if (s.level === 'Procedural Map' || s.level === 'Barren') {
    args.push('+server.worldsize', String(s.worldsize), '+server.seed', String(s.seed));
  }
  if (s.url) args.push('+server.url', s.url);
  if (s.headerimage) args.push('+server.headerimage', s.headerimage);
  // Argumentos extra escritos por el usuario (respeta comillas dobles)
  if (s.extraArgs) {
    const extra = s.extraArgs.match(/"[^"]*"|\S+/g) || [];
    args.push(...extra.map(a => a.replace(/^"|"$/g, '')));
  }
  return args;
}

function start() {
  if (config.isRemote()) throw E('remote_no_process');
  if (proc || attached) throw E('already_running');
  const p = config.serverPaths();
  if (config.isWin() !== config.IS_WIN) {
    throw E('platform_mismatch', { files: config.isWin() ? 'Windows' : 'Linux', host: config.IS_WIN ? 'Windows' : 'Linux' });
  }
  if (!fs.existsSync(p.exe)) throw E('not_installed');
  const args = buildArgs();
  // En Windows RustDedicated no escribe en stdout: se usa un archivo de log que el panel va leyendo
  let logFile = null;
  if (config.IS_WIN) {
    logFile = path.join(p.root, 'logs', `${config.get().server.identity}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    args.push('-logfile', logFile);
  }
  const env = { ...process.env };
  let cmd = p.exe;
  let finalArgs = args;

  if (!config.IS_WIN) {
    const plug = path.join(p.root, 'RustDedicated_Data', 'Plugins');
    env.LD_LIBRARY_PATH = [p.root, plug, path.join(plug, 'x86_64'), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const carbonEnv = path.join(p.root, 'carbon', 'tools', 'environment.sh');
    if (config.get().server.framework === 'carbon' && fs.existsSync(carbonEnv)) {
      // Carbon en Linux necesita cargar Doorstop mediante su environment.sh
      cmd = 'bash';
      finalArgs = ['-c', 'source ./carbon/tools/environment.sh && exec ./RustDedicated "$@"', 'rust', ...args];
    }
  }

  log('panel', L('starting', { cmd: `${path.basename(p.exe)} ${args.map(a => a === config.get().server.rconPassword ? '****' : a).join(' ')}` }));
  expectedExit = false;
  proc = spawn(cmd, finalArgs, { cwd: p.root, env, windowsHide: true });
  startedAt = Date.now();
  setStatus('starting');

  let tail = '';
  const onData = (d) => {
    const lines = (tail + d.toString()).split(/\r?\n/);
    tail = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      // Filtra el ruido típico de Unity
      if (/^(Fallback handler could not load|\(Filename: )/.test(l)) continue;
      // Eventos del complemento ScrapwardenBridge: no se muestran en la consola, van a Vigilancia
      const bi = l.indexOf('RPANEL|');
      if (bi !== -1) {
        try { bus.emit('bridge', JSON.parse(l.slice(bi + 7))); } catch {}
        continue;
      }
      log('server', l);
      bus.emit('serverline', l);
      if (status === 'starting' && /Server startup complete|SteamServer Initialized/i.test(l)) {
        setStatus('running');
        crashCount = 0;
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  if (logFile) startTail(logFile, onData);

  proc.on('error', (e) => log('panel', L('spawn_error', { error: e.message })));
  proc.on('close', (code, signal) => {
    log('panel', L('stopped', { code: signal ? `${code}, ${signal}` : code }));
    proc = null;
    startedAt = null;
    winStats = null;
    stopTail();
    rcon.disconnect();
    setStatus('stopped');
    if (!expectedExit && config.get().server.autoRestartOnCrash) {
      crashCount++;
      if (crashCount <= 5) {
        const delay = Math.min(60, 10 * crashCount);
        log('panel', L('crash_restart', { s: delay, n: crashCount }));
        setTimeout(() => { if (!proc) try { start(); } catch (e) { log('panel', L('error', { error: errParam(e) })); } }, delay * 1000);
      } else {
        log('panel', L('crash_giveup'));
      }
    }
  });

  // RCON reintenta cada 5 s hasta que el servidor lo abre
  setTimeout(() => { if (proc) rcon.connect(); }, 15000);
}

// Lectura incremental de un archivo de log (sondeo cada 500 ms)
function startTail(file, onData) {
  stopTail();
  let pos = 0;
  const timer = setInterval(() => {
    fs.stat(file, (err, st) => {
      if (err || st.size <= pos) { if (!err && st.size < pos) pos = 0; return; }
      const stream = fs.createReadStream(file, { start: pos, end: st.size - 1 });
      pos = st.size;
      stream.on('data', onData);
    });
  }, 500);
  logTail = timer;
}
function stopTail() { if (logTail) clearInterval(logTail); logTail = null; }

function stop({ timeoutSec = 90 } = {}) {
  if (!proc && attached) return stopAttached(timeoutSec);
  return new Promise(async (resolve) => {
    if (!proc) return resolve();
    expectedExit = true;
    crashCount = 0;
    setStatus('stopping');
    const current = proc;
    const killer = setTimeout(() => {
      log('panel', L('stop_timeout'));
      try { current.kill('SIGKILL'); } catch {}
    }, timeoutSec * 1000);
    current.once('close', () => { clearTimeout(killer); resolve(); });
    try {
      await rcon.command('server.save', 30000);
      await rcon.command('quit', 5000).catch(() => {});
    } catch {
      // Sin RCON: señal de terminación normal
      try { current.kill(config.IS_WIN ? undefined : 'SIGTERM'); } catch {}
    }
  });
}

// Parar un servidor que no arrancó el panel: guardar y "quit" por RCON, y esperar a que se cierre la conexión
function stopAttached(timeoutSec = 90) {
  return new Promise(async (resolve) => {
    stoppingAttached = true;
    setStatus('stopping');
    const done = () => { clearTimeout(timer); bus.off('rcon', onRcon); stoppingAttached = false; resolve(); };
    const onRcon = ({ connected }) => { if (!connected) done(); };
    const timer = setTimeout(done, timeoutSec * 1000);
    bus.on('rcon', onRcon);
    try { await rcon.command('server.save', 30000); } catch {}
    await rcon.command('quit', 5000).catch(() => {});
  });
}

// Detecta Oxide o Carbon por RCON (en modo remoto no hay carpetas que mirar)
async function detectFramework() {
  const ok = (out) => out && !/not found|unknown command|invalid command|no such command/i.test(out);
  const ox = await rcon.command('oxide.version', 6000).catch(() => '');
  if (ok(ox) && /oxide/i.test(ox)) return 'oxide';
  const cb = await rcon.command('c.version', 6000).catch(() => '');
  if (ok(cb) && /carbon/i.test(cb)) return 'carbon';
  return 'none';
}

// Conexión RCON con un servidor que el panel no ha arrancado: se "adopta"
bus.on('rcon', async ({ connected }) => {
  if (proc) return;
  if (connected) {
    attached = true;
    rcon.setConsoleViaRcon(true);
    const info = await rcon.json('serverinfo', 8000).catch(() => null);
    startedAt = info?.Uptime ? Date.now() - info.Uptime * 1000 : Date.now();
    log('panel', L(config.isRemote() ? 'remote_attached' : 'local_attached', { host: config.rconTarget().host, name: info?.Hostname || '' }));
    if (config.isRemote()) {
      const fw = await detectFramework();
      if (fw !== config.get().server.framework) config.update('server', { framework: fw });
    }
    setStatus('running');
  } else if (attached) {
    attached = false;
    startedAt = null;
    rcon.setConsoleViaRcon(false);
    setStatus('stopped');
  }
});

// Vigila si hay un servidor al que conectarse aunque no lo haya arrancado el panel
function watchExternal() {
  const tryConnect = () => {
    if (proc || rcon.isWanted()) return;
    const t = config.rconTarget();
    if (!t.host || !t.password) return;
    if (!config.isRemote() && !fs.existsSync(config.serverPaths().exe)) return;
    rcon.connect();
  };
  setTimeout(tryConnect, 3000);
  setInterval(tryConnect, 20000);
}

// Cambio de modo o de credenciales: se reinicia la conexión
function reconnect() {
  if (proc) return;
  rcon.disconnect();
  if (attached) { attached = false; startedAt = null; rcon.setConsoleViaRcon(false); setStatus('stopped'); }
  setTimeout(() => { const t = config.rconTarget(); if (t.host && t.password) rcon.connect(); }, 500);
}

function kill() {
  if (!proc) return;
  expectedExit = true;
  proc.kill('SIGKILL');
}

async function restart() {
  if (config.isRemote()) {
    // En remoto el panel no puede arrancar el proceso: guarda y lo cierra para que el hosting lo vuelva a levantar
    if (!rcon.isConnected()) throw E('rcon_not_connected');
    log('panel', L('remote_restart'));
    await rcon.command('server.save', 30000).catch(() => {});
    await rcon.command('quit', 5000).catch(() => {});
    return;
  }
  await stop();
  await new Promise(r => setTimeout(r, 3000));
  start();
}

// Uso de CPU/RAM del proceso: Linux vía /proc, Windows vía PowerShell (cacheado)
function resources() {
  if (!proc) return null;
  if (config.IS_WIN) { pollWindows(); return winStats; }
  try {
    const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(stat[11]) + Number(stat[12]); // utime + stime
    const rssPages = Number(stat[21]);
    const now = Date.now();
    let cpu = 0;
    if (lastCpu && lastCpu.pid === proc.pid) {
      cpu = ((ticks - lastCpu.ticks) / 100) / ((now - lastCpu.t) / 1000) * 100;
    }
    lastCpu = { pid: proc.pid, ticks, t: now };
    return { cpu: Math.max(0, Math.round(cpu)), ramMB: Math.round(rssPages * 4096 / 1048576) };
  } catch { return null; }
}

let winPolling = false;
function pollWindows() {
  if (winPolling || !proc) return;
  winPolling = true;
  const pid = proc.pid;
  const ps = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){"$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"}`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
    winPolling = false;
    if (err || !out.trim()) return;
    const [cpuSec, ws] = out.trim().split(/\s+/).map(Number);
    const now = Date.now();
    let cpu = 0;
    if (lastCpu && lastCpu.pid === pid) cpu = (cpuSec - lastCpu.ticks) / ((now - lastCpu.t) / 1000) * 100;
    lastCpu = { pid, ticks: cpuSec, t: now };
    winStats = { cpu: Math.max(0, Math.round(cpu)), ramMB: Math.round(ws / 1048576) };
  });
}

module.exports = { start, stop, kill, restart, getStatus, resources, watchExternal, reconnect, detectFramework, isRunning: () => !!proc || attached, isManaged: () => !!proc };
