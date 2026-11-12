// Autenticación: varios administradores (usuario + contraseña scrypt) con roles y sesión firmada en cookie
const crypto = require('crypto');
const config = require('./config');
const { tr, E } = require('./i18n');
const { ROLES, permsOf } = require('./roles');
const totp = require('./totp');

const SESSION_HOURS = 12;
const failed = new Map(); // ip -> { count, until }
const fail = (res, status, code) => res.status(status).json({ error: tr('es', 'err.' + code), code });

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// ---------- Usuarios ----------
const users = () => config.get().users || [];
const saveUsers = (list) => { config.get().users = list; config.save(); };
const findUser = (name) => users().find(u => u.username.toLowerCase() === String(name || '').trim().toLowerCase());
const findId = (id) => users().find(u => u.id === id);
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, created: u.created, lastLogin: u.lastLogin || null, twoFactor: !!u.totp?.enabled });

// Migración desde la versión con una sola contraseña: se convierte en el usuario "admin" (propietario)
function migrate() {
  const c = config.get();
  if (!c.users) c.users = [];
  if (c.panel.passwordHash && !c.users.length) {
    c.users.push({ id: crypto.randomUUID(), username: 'admin', hash: c.panel.passwordHash, role: 'owner', created: Date.now(), tv: 1 });
  }
  delete c.panel.passwordHash;
  config.save();
}

const USER_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
function validate(username, password, { requirePw = true } = {}) {
  if (username !== undefined && !USER_RE.test(username || '')) throw E('bad_username');
  if (requirePw && (password || '').length < 8) throw E('password_short');
}

function createUser({ username, password, role }) {
  username = String(username || '').trim();
  validate(username, password);
  if (!ROLES[role]) throw E('bad_role');
  if (findUser(username)) throw E('user_exists');
  const u = { id: crypto.randomUUID(), username, hash: hashPassword(password), role, created: Date.now(), tv: 1 };
  saveUsers([...users(), u]);
  return publicUser(u);
}

function updateUser(id, { role, password, reset2fa }, actor) {
  const list = users();
  const u = list.find(x => x.id === id);
  if (!u) throw E('user_not_found');
  if (role !== undefined) {
    if (!ROLES[role]) throw E('bad_role');
    if (u.role === 'owner' && role !== 'owner' && list.filter(x => x.role === 'owner').length === 1) throw E('last_owner');
    if (u.id === actor.id && role !== u.role) throw E('own_role');
    u.role = role;
    u.tv = (u.tv || 1) + 1; // cierra sus sesiones para aplicar el nuevo rol
  }
  if (password) { validate(undefined, password); u.hash = hashPassword(password); u.tv = (u.tv || 1) + 1; }
  if (reset2fa) { u.totp = null; delete u.totpPending; u.tv = (u.tv || 1) + 1; }
  saveUsers(list);
  return publicUser(u);
}

function deleteUser(id, actor) {
  const list = users();
  const u = list.find(x => x.id === id);
  if (!u) throw E('user_not_found');
  if (u.id === actor.id) throw E('delete_self');
  if (u.role === 'owner' && list.filter(x => x.role === 'owner').length === 1) throw E('last_owner');
  saveUsers(list.filter(x => x.id !== id));
}

function changeOwnPassword(user, current, password) {
  const u = findId(user.id);
  if (!verifyPassword(current || '', u.hash)) throw E('wrong_current_password');
  validate(undefined, password);
  u.hash = hashPassword(password);
  u.tv = (u.tv || 1) + 1;
  config.save();
}

// ---------- Sesiones ----------
function sign(payload) {
  const secret = config.get().panel.sessionSecret;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Devuelve el usuario de la sesión o null. Cambiar contraseña o rol invalida las sesiones anteriores.
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.get().panel.sessionSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (d.exp < Date.now() || d.stage) return null;
    const u = findId(d.uid);
    if (!u || (u.tv || 1) !== d.tv) return null;
    return u;
  } catch { return null; }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const tokenFromReq = (req) => parseCookies(req.headers.cookie).rp_session;
const isSetup = () => users().length > 0;

function startSession(res, u) {
  const token = sign({ uid: u.id, tv: u.tv || 1, exp: Date.now() + SESSION_HOURS * 3600_000 });
  res.setHeader('Set-Cookie', `rp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}

function login(req, res, username, password) {
  const ip = req.socket.remoteAddress;
  const f = failed.get(ip);
  if (f && f.until > Date.now()) return fail(res, 429, 'too_many_attempts');
  const u = findUser(username);
  // Se calcula el hash aunque el usuario no exista para no revelar qué usuarios hay
  const ok = verifyPassword(password || '', u ? u.hash : 'aa:' + '0'.repeat(128));
  if (!u || !ok) {
    const count = (f?.count || 0) + 1;
    failed.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
    return fail(res, 401, 'wrong_login');
  }
  failed.delete(ip);
  // Con verificación en dos pasos: se devuelve un vale de 5 minutos en lugar de la sesión
  if (u.totp?.enabled) {
    return res.json({ need2fa: true, ticket: sign({ uid: u.id, tv: u.tv || 1, stage: '2fa', exp: Date.now() + 5 * 60_000 }) });
  }
  finishLogin(req, res, u);
}

function finishLogin(req, res, u) {
  u.lastLogin = Date.now();
  config.save();
  req.user = u;
  startSession(res, u);
  res.json({ ok: true });
}

function readTicket(ticket) {
  if (!ticket || !ticket.includes('.')) return null;
  const [body, sig] = ticket.split('.');
  const expected = crypto.createHmac('sha256', config.get().panel.sessionSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (d.stage !== '2fa' || d.exp < Date.now()) return null;
    const u = findId(d.uid);
    return u && (u.tv || 1) === d.tv && u.totp?.enabled ? u : null;
  } catch { return null; }
}

// Segundo paso: código de la app o código de recuperación (de un solo uso)
function login2fa(req, res, ticket, code) {
  const ip = req.socket.remoteAddress;
  const f = failed.get(ip);
  if (f && f.until > Date.now()) return fail(res, 429, 'too_many_attempts');
  const u = readTicket(ticket);
  if (!u) return fail(res, 401, 'twofa_expired');
  const c = String(code || '').trim();
  let ok = false;
  const counter = totp.verify(u.totp.secret, c, u.totp.last ?? -1);
  if (counter !== null) { u.totp.last = counter; ok = true; }
  else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(c)) {
    const h = totp.hashCode(c);
    const i = (u.totp.recovery || []).indexOf(h);
    if (i >= 0) { u.totp.recovery.splice(i, 1); ok = true; }
  }
  if (!ok) {
    const count = (f?.count || 0) + 1;
    failed.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
    return fail(res, 401, 'twofa_bad_code');
  }
  failed.delete(ip);
  finishLogin(req, res, u);
}

// ---------- Configurar 2FA del propio usuario ----------
async function setup2fa(user) {
  const u = findId(user.id);
  if (u.totp?.enabled) throw E('twofa_already');
  u.totpPending = totp.newSecret();
  config.save();
  const uri = totp.uri(u.totpPending, u.username);
  const qr = await require('qrcode').toString(uri, { type: 'svg', margin: 1, color: { dark: '#12171B', light: '#FFFFFF' } });
  return { secret: u.totpPending, uri, qr };
}
function enable2fa(user, code) {
  const u = findId(user.id);
  if (!u.totpPending) throw E('twofa_no_setup');
  const counter = totp.verify(u.totpPending, code);
  if (counter === null) throw E('twofa_bad_code');
  const codes = totp.recoveryCodes();
  u.totp = { secret: u.totpPending, enabled: true, last: counter, recovery: codes.map(totp.hashCode), since: Date.now() };
  delete u.totpPending;
  config.save();
  return { recovery: codes };
}
function disable2fa(user, password) {
  const u = findId(user.id);
  if (!verifyPassword(password || '', u.hash)) throw E('wrong_current_password');
  u.totp = null;
  delete u.totpPending;
  config.save();
}
function regenRecovery(user, password) {
  const u = findId(user.id);
  if (!u.totp?.enabled) throw E('twofa_no_setup');
  if (!verifyPassword(password || '', u.hash)) throw E('wrong_current_password');
  const codes = totp.recoveryCodes();
  u.totp.recovery = codes.map(totp.hashCode);
  config.save();
  return { recovery: codes };
}

function setupOwner(req, res, username, password) {
  if (isSetup()) throw E('already_setup');
  const u = createUser({ username, password, role: 'owner' });
  return login(req, res, u.username, password);
}

function logout(res) {
  res.setHeader('Set-Cookie', 'rp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}

function middleware(req, res, next) {
  const u = verifyToken(tokenFromReq(req));
  if (!u) return fail(res, 401, 'not_authenticated');
  req.user = u;
  next();
}

const me = (u) => ({ ...publicUser(u), perms: permsOf(u.role), recoveryLeft: u.totp?.enabled ? (u.totp.recovery || []).length : null });

module.exports = {
  migrate, middleware, login, login2fa, setup2fa, enable2fa, disable2fa, regenRecovery, logout, setupOwner, isSetup, verifyToken, tokenFromReq, me,
  listUsers: () => users().map(publicUser), createUser, updateUser, deleteUser, changeOwnPassword,
};
