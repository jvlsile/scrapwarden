// Acceso a los archivos del servidor con la misma interfaz en local y en remoto (FTP, FTPS o SFTP).
// Las rutas son relativas a la carpeta del servidor (donde está RustDedicated), con "/" como separador;
// en local también se aceptan rutas absolutas (la carpeta de plugins desactivados vive en data/).
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const config = require('./config');
const { E } = require('./i18n');

const PROTOCOLS = ['off', 'ftp', 'ftps', 'sftp'];
const DEFAULTS = { protocol: 'off', host: '', port: 0, user: '', password: '', root: '/' };
const settings = () => ({ ...DEFAULTS, ...((config.get().remote || {}).files || {}) });
const defaultPort = (p) => (p === 'sftp' ? 22 : 21);
const clean = (rel) => {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (parts.includes('..')) throw E('files_bad_path');
  return parts.join('/');
};

// ---------- Local ----------
const local = {
  kind: 'local',
  abs(rel) { return path.isAbsolute(rel) ? rel : path.join(config.serverPaths().root, ...clean(rel).split('/')); },
  async list(dir) {
    try {
      return fs.readdirSync(this.abs(dir), { withFileTypes: true }).map(e => {
        let st = null; try { st = fs.statSync(path.join(this.abs(dir), e.name)); } catch {}
        return { name: e.name, dir: e.isDirectory(), size: st?.size || 0, mtime: st?.mtimeMs || 0 };
      });
    } catch { return []; }
  },
  async exists(p) { return fs.existsSync(this.abs(p)); },
  async read(p) { try { return fs.readFileSync(this.abs(p)); } catch { throw E('files_not_found', { file: p }); } },
  async write(p, data) { const f = this.abs(p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); },
  async remove(p) { fs.rmSync(this.abs(p), { force: true, recursive: true }); },
  async rename(a, b) { const t = this.abs(b); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.renameSync(this.abs(a), t); },
  async copy(a, b) { fs.copyFileSync(this.abs(a), this.abs(b)); },
};

// ---------- Remoto: una sola conexión, operaciones en cola y cierre tras 60 s sin uso ----------
class Remote {
  constructor(s) { this.s = s; this.kind = s.protocol; this.client = null; this.chain = Promise.resolve(); this.idle = null; }
  base() { return '/' + clean(this.s.root); }
  abs(rel) { const r = clean(rel); const b = this.base(); return (b === '/' ? '' : b) + '/' + r; }
  run(fn) {
    const job = this.chain.then(async () => {
      clearTimeout(this.idle);
      const reused = !!this.client;
      try { return await fn(await this.connect()); }
      catch (e) {
        if (['files_not_found', 'files_denied', 'files_auth', 'files_bad_path'].includes(e.code)) throw e;
        // Error de conexión: se descarta el cliente; si la conexión venía de antes (el hosting la cerró), se reintenta una vez
        await this.close();
        if (reused) return await fn(await this.connect());
        throw e;
      } finally { clearTimeout(this.idle); this.idle = setTimeout(() => this.close(), 60000); this.idle.unref?.(); }
    });
    this.chain = job.catch(() => {});
    return job;
  }
  async connect() {
    if (this.client) return this.client;
    const s = this.s, port = s.port || defaultPort(s.protocol);
    try {
      if (s.protocol === 'sftp') {
        const SftpClient = require('ssh2-sftp-client');
        const c = new SftpClient('oxidian', { error: () => {}, end: () => {}, close: () => {} });
        await c.connect({ host: s.host, port, username: s.user, password: s.password, readyTimeout: 15000, retries: 1 });
        this.client = { type: 'sftp', c };
      } else {
        const ftp = require('basic-ftp');
        const c = new ftp.Client(20000);
        await c.access({ host: s.host, port, user: s.user, password: s.password, secure: s.protocol === 'ftps', secureOptions: { rejectUnauthorized: false } });
        this.client = { type: 'ftp', c };
      }
    } catch (e) { throw mapError(e); }
    return this.client;
  }
  async close() {
    const c = this.client; this.client = null;
    if (!c) return;
    try { if (c.type === 'sftp') await c.c.end(); else c.c.close(); } catch {}
  }
  async list(dir) {
    return this.run(async ({ type, c }) => {
      try {
        if (type === 'sftp') return (await c.list(this.abs(dir))).map(e => ({ name: e.name, dir: e.type === 'd', size: e.size, mtime: e.modifyTime || 0 }));
        return (await c.list(this.abs(dir))).map(e => ({ name: e.name, dir: e.isDirectory, size: e.size, mtime: e.modifiedAt ? e.modifiedAt.getTime() : 0 }));
      } catch (e) { if (isMissing(e)) return []; throw mapError(e); }
    });
  }
  async exists(p) {
    const r = clean(p), parent = r.split('/').slice(0, -1).join('/'), name = r.split('/').pop();
    return (await this.list(parent)).some(e => e.name === name);
  }
  async read(p) {
    return this.run(async ({ type, c }) => {
      try {
        if (type === 'sftp') return await c.get(this.abs(p));
        const chunks = [];
        const sink = new Writable({ write(ch, _e, cb) { chunks.push(Buffer.from(ch)); cb(); } });
        await c.downloadTo(sink, this.abs(p));
        return Buffer.concat(chunks);
      } catch (e) { if (isMissing(e)) throw E('files_not_found', { file: p }); throw mapError(e); }
    });
  }
  async write(p, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const file = this.abs(p), dir = file.split('/').slice(0, -1).join('/') || '/';
    return this.run(async ({ type, c }) => {
      try {
        if (type === 'sftp') { if (!(await c.exists(dir))) await c.mkdir(dir, true); await c.put(buf, file); return; }
        const { Readable } = require('stream');
        await c.ensureDir(dir); // basic-ftp cambia de carpeta: se vuelve a la raíz después
        await c.cd('/');
        await c.uploadFrom(Readable.from(buf), file);
      } catch (e) { throw mapError(e); }
    });
  }
  async remove(p) {
    return this.run(async ({ type, c }) => {
      try {
        if (type === 'sftp') { const t = await c.exists(this.abs(p)); if (t === 'd') await c.rmdir(this.abs(p), true); else if (t) await c.delete(this.abs(p)); return; }
        try { await c.remove(this.abs(p)); } catch (e) { if (isMissing(e)) return; try { await c.removeDir(this.abs(p)); await c.cd('/'); } catch (e2) { if (!isMissing(e2)) throw e2; } }
      } catch (e) { throw mapError(e); }
    });
  }
  async rename(a, b) {
    const to = this.abs(b), dir = to.split('/').slice(0, -1).join('/') || '/';
    return this.run(async ({ type, c }) => {
      try {
        if (type === 'sftp') { if (!(await c.exists(dir))) await c.mkdir(dir, true); await c.rename(this.abs(a), to); return; }
        await c.ensureDir(dir); await c.cd('/');
        await c.rename(this.abs(a), to);
      } catch (e) { if (isMissing(e)) throw E('files_not_found', { file: a }); throw mapError(e); }
    });
  }
  async copy(a, b) { await this.write(b, await this.read(a)); }
}

const isMissing = (e) => /no such file|not found|550|does not exist|ENOENT/i.test(String(e?.message || e)) || e?.code === 550 || e?.code === 2;
function mapError(e) {
  if (e && e.code && typeof e.code === 'string' && e.params !== undefined) return e; // ya es un error del panel
  const m = String(e?.message || e);
  if (/530|auth|login incorrect|password|permission denied \(password/i.test(m) || e?.code === 530) return E('files_auth');
  if (/ECONNREFUSED/i.test(m)) return E('files_refused');
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return E('files_not_found_host');
  if (/ETIMEDOUT|Timed out|timeout/i.test(m)) return E('files_timeout');
  if (/550|denied|permission/i.test(m)) return E('files_denied');
  return E('files_error', { error: m.slice(0, 160) });
}

let remoteInst = null, remoteKey = '';
// Devuelve el acceso a archivos que corresponde: local, remoto configurado o null (remoto sin FTP/SFTP)
function current() {
  if (!config.isRemote()) return local;
  const s = settings();
  if (s.protocol === 'off' || !s.host) return null;
  const key = JSON.stringify(s);
  if (!remoteInst || key !== remoteKey) { if (remoteInst) remoteInst.close(); remoteInst = new Remote(s); remoteKey = key; }
  return remoteInst;
}
const available = () => !!current();

// Prueba unas credenciales: conecta, lista la carpeta y dice qué ha encontrado
async function test(input) {
  const s = { ...settings(), ...input };
  if (!s.host) s.host = (config.get().remote || {}).host || '';
  if (!input.password) s.password = settings().password;
  if (!s.host || !s.user) throw E('files_incomplete');
  const r = new Remote(s);
  try {
    const top = await r.list('');
    if (!top.length && !(await r.list('server')).length) {
      // Puede que la carpeta raíz no sea la del servidor
      throw E('files_empty_root', { root: s.root || '/' });
    }
    const names = top.map(e => e.name.toLowerCase());
    return {
      ok: true,
      found: {
        exe: names.includes('rustdedicated.exe') || names.includes('rustdedicated'),
        oxide: names.includes('oxide'), carbon: names.includes('carbon'), server: names.includes('server'),
      },
      entries: top.slice(0, 40).map(e => ({ name: e.name, dir: e.dir })),
    };
  } finally { await r.close(); }
}

function view() {
  const s = settings();
  return { protocol: s.protocol, host: s.host, port: s.port || '', user: s.user, root: s.root, hasPassword: !!s.password };
}

function update(input = {}) {
  const cur = settings(), out = { ...cur };
  if ('protocol' in input) { if (!PROTOCOLS.includes(input.protocol)) throw E('bad_value', { value: input.protocol }); out.protocol = input.protocol; }
  if ('host' in input) {
    const h = String(input.host || '').trim();
    if (h && !/^[a-z0-9.\-:[\]]{1,253}$/i.test(h)) throw E('remote_bad_host');
    out.host = h;
  }
  if ('port' in input) { const p = parseInt(input.port, 10); out.port = p >= 1 && p <= 65535 ? p : 0; }
  if ('user' in input) out.user = String(input.user || '').trim().slice(0, 128);
  if (input.password) out.password = String(input.password).slice(0, 256);
  if (input.clearPassword) out.password = '';
  if ('root' in input) out.root = '/' + clean(input.root);
  if (out.protocol !== 'off' && !out.host) out.host = (config.get().remote || {}).host || ''; // por defecto, el mismo host que RCON
  if (out.protocol !== 'off' && (!out.host || !out.user)) throw E('files_incomplete');
  config.update('remote', { files: out });
  return view();
}

module.exports = { current, available, test, view, update, settings, local, clean };
