// Oxidian — panel web para instalar y administrar servidores de Rust
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./lib/config');
config.load();
const auth = require('./lib/auth');
auth.migrate();
const server = require('./lib/server');
const rcon = require('./lib/rcon');
const installer = require('./lib/installer');
const plugins = require('./lib/plugins');
const maint = require('./lib/maintenance');
const watch = require('./lib/watch');
const steam = require('./lib/steam');
const liveMap = require('./lib/map');
const audit = require('./lib/audit');
const moderation = require('./lib/moderation');
const rates = require('./lib/rates');
const world = require('./lib/world');
const stats = require('./lib/stats');
const wipes = require('./lib/wipes');
const perf = require('./lib/perf');
const publicPage = require('./lib/publicpage');
const discordBot = require('./lib/discordbot');
const tickets = require('./lib/tickets');
const vip = require('./lib/vip');
const store = require('./lib/store');
const update = require('./lib/update');
const importer = require('./lib/importer');
const ipcheck = require('./lib/ipcheck');
const files = require('./lib/files');
const banlist = require('./lib/banlist');
const staff = require('./lib/staff');
const { can } = require('./lib/roles');
const { bus, consoleBuffer, log } = require('./lib/bus');
const i18n = require('./lib/i18n');
const { E, L, errParam } = i18n;
const sayT = (key, params) => rcon.say(i18n.tr(config.get().panel.notifyLang || 'es', key, params));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Envuelve handlers async y devuelve errores como JSON
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: e.message, code: e.code, params: e.params });
  }
};
const steamId = (v) => { if (!/^\d{17}$/.test(String(v || ''))) throw E('bad_steamid'); return String(v); };
const q = (s) => `"${String(s || '').replace(/"/g, "'")}"`;

// ---------- Auth / primer arranque ----------
app.get('/api/setup', (req, res) => res.json({ setup: auth.isSetup(), authed: !!auth.verifyToken(auth.tokenFromReq(req)) }));
app.post('/api/setup', h((req, res) => auth.setupOwner(req, res, req.body.username, req.body.password)));
app.get('/api/languages', (req, res) => res.json(i18n.available()));

// ---------- Web pública (sin login): solo datos pensados para los jugadores ----------
app.get('/server', (req, res) => {
  if (!publicPage.settings().enabled) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'server.html'));
});
app.get('/public-api/data', h(async (req, res) => { res.set('Cache-Control', 'public, max-age=10'); return publicPage.data(); }));
app.get('/public-api/map.jpg', (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=300'); res.sendFile(publicPage.mapImage()); }
  catch (e) { res.status(404).json({ error: e.message, code: e.code }); }
});
// Baneos compartidos: lo consultan los servidores de Rust (server.bansServerEndpoint), con clave secreta en la ruta
app.get('/rustbans/:token/:steamid', (req, res) => { banlist.handle(req, res).catch(() => { if (!res.headersSent) res.status(500).end(); }); });
app.post('/api/login', (req, res) => auth.login(req, res, req.body.username, req.body.password));
app.post('/api/login/2fa', (req, res) => auth.login2fa(req, res, req.body.ticket, req.body.code));
app.post('/api/logout', (req, res) => auth.logout(res));

app.use('/api', auth.middleware);

// ---------- Permisos por ruta y registro de actividad ----------
// [método, ruta, permiso (o función), acción para el registro]
const PA_PERM = { kick: 'players.kick', ban: 'players.ban', unban: 'players.ban', owner: 'players.admin', moderator: 'players.admin', removeowner: 'players.admin', removemoderator: 'players.admin', give: 'players.give' };
const ACL = [
  ['GET', /^\/api\/me$/, null],
  ['GET', /^\/api\/users$/, 'users'],
  ['GET', /^\/api\/audit$/, 'audit'],
  ['GET', /^\/api\/players\/\d+\/inventory$/, 'inventory.view'],
  ['GET', /^\/api\/plugins\/[^/]+\/config$/, 'plugins'],
  ['GET', /^\/api\/backups\/[^/]+\/download$/, 'backups'],
  ['GET', /^\/api\/watch\/player\//, 'watch.review'],
  ['GET', /^\/api\/steam\/settings$/, 'watch.settings'],
  ['GET', /^\/api\/ipcheck$/, 'watch.settings'],
  ['GET', /^\/api\/mod\/(policy|filter)$/, 'view'],
  ['GET', /^\/api\/mod\/\d{17}$/, 'players.moderate'],
  ['GET', /^\/api\/discord$/, 'server.config'],
  ['GET', /^\/api\/tickets/, 'players.moderate'],
  ['GET', /^\/api\/vip$/, 'perms'],
  ['GET', /^\/api\/store$/, 'server.config'],
  ['GET', /^\/api\/import\//, 'install'],
  ['GET', /^\/api\/remote$/, 'server.config'],
  ['GET', /^\/api\/remote\/files$/, 'server.config'],
  ['GET', /^\/api\/staff$/, 'perms'],
  ['GET', /^\/api\/banlist\/check\/\d{17}$/, 'players.ban'],
  ['GET', /./, 'view'],
  ['POST', /^\/api\/password$/, null, 'password'],
  ['POST', /^\/api\/2fa\/setup$/, null, null],
  ['POST', /^\/api\/2fa\/(enable|disable|recovery)$/, null, '2fa_$1'],
  ['POST', /^\/api\/chat\/pm$/, 'players.moderate', 'chat_pm'],
  ['POST', /^\/api\/mod\/\d{17}\/(note|warn|mute|unmute)$/, 'players.moderate', 'mod_$1'],
  ['DELETE', /^\/api\/mod\/\d{17}\/(note|warn)\//, 'players.moderate', 'mod_$1_delete'],
  ['POST', /^\/api\/mod\/\d{17}\/tempban$/, 'players.ban', 'mod_tempban'],
  ['PUT', /^\/api\/mod\/(policy|filter)$/, 'watch.settings', 'mod_$1'],
  ['POST', /^\/api\/users$/, 'users', 'user_create'],
  ['PUT', /^\/api\/users\/[^/]+$/, 'users', 'user_update'],
  ['DELETE', /^\/api\/users\/[^/]+$/, 'users', 'user_delete'],
  ['PUT', /^\/api\/panel$/, 'server.config', 'notify_lang'],
  ['PUT', /^\/api\/panel\/icons$/, 'server.config', 'item_icons'],
  ['PUT', /^\/api\/rates$/, 'server.config', 'rates'],
  ['PUT', /^\/api\/rates\/mode$/, 'server.config', 'pve_mode'],
  ['POST', /^\/api\/world\/(time|weather|event)$/, 'server.control', 'world_$1'],
  ['PUT', /^\/api\/wipes$/, 'wipe', 'wipe_plan'],
  ['PUT', /^\/api\/perf$/, 'server.config', 'perf'],
  ['PUT', /^\/api\/public$/, 'server.config', 'public_page'],
  ['PUT', /^\/api\/discord$/, 'server.config', 'discord_bot'],
  ['POST', /^\/api\/tickets\/\d+\/(assign|unassign|comment|reopen)$/, 'players.moderate', 'ticket_$1'],
  ['POST', /^\/api\/tickets\/\d+\/close$/, (req) => ({ ban: 'players.ban', tempban: 'players.ban', kick: 'players.kick' }[req.body.resolution] || 'players.moderate'), 'ticket_close'],
  ['POST', /^\/api\/vip$/, 'perms', 'vip_grant'],
  ['DELETE', /^\/api\/vip\//, 'perms', 'vip_remove'],
  ['PUT', /^\/api\/vip$/, 'perms', 'vip_settings'],
  ['PUT', /^\/api\/store$/, 'server.config', 'store_settings'],
  ['PUT', /^\/api\/update$/, 'server.config', 'update_check'],
  ['POST', /^\/api\/import\/scan$/, 'install', null],
  ['POST', /^\/api\/import\/apply$/, 'install', 'server_import'],
  ['POST', /^\/api\/remote\/test$/, 'server.config', null],
  ['PUT', /^\/api\/remote$/, 'server.config', 'remote_mode'],
  ['POST', /^\/api\/remote\/disable$/, 'server.config', 'remote_disable'],
  ['POST', /^\/api\/remote\/files\/test$/, 'server.config', null],
  ['PUT', /^\/api\/remote\/files$/, 'server.config', 'remote_files'],
  ['POST', /^\/api\/update\/check$/, 'view', null],
  ['POST', /^\/api\/store\/(test|check)$/, 'server.config', null],
  ['POST', /^\/api\/staff$/, 'perms', 'staff_add'],
  ['PUT', /^\/api\/banlist$/, 'server.config', 'banlist_settings'],
  ['PUT', /^\/api\/banlist\/sources$/, 'server.config', 'banlist_sources'],
  ['POST', /^\/api\/banlist\/sources\/test$/, 'server.config', null],
  ['POST', /^\/api\/banlist\/keys$/, 'server.config', 'banlist_key_add'],
  ['POST', /^\/api\/banlist\/keys\/[^/]+\/(reveal|rotate)$/, 'server.config', 'banlist_key_$1'],
  ['DELETE', /^\/api\/banlist\/keys\//, 'server.config', 'banlist_key_remove'],
  ['POST', /^\/api\/banlist\/bans$/, 'players.ban', 'banlist_ban'],
  ['DELETE', /^\/api\/banlist\/bans\//, 'players.ban', 'banlist_unban'],
  ['POST', /^\/api\/staff\/sync$/, 'perms', null],
  ['DELETE', /^\/api\/staff\//, 'perms', 'staff_remove'],
  ['POST', /^\/api\/wipes\/skip$/, 'wipe', 'wipe_skip'],
  ['PUT', /^\/api\/config\/server$/, 'server.config', 'config'],
  ['PUT', /^\/api\/config\/schedule$/, 'schedule', 'schedule'],
  ['PUT', /^\/api\/platform$/, 'install', 'platform'],
  ['POST', /^\/api\/install\/server$/, 'install', 'install_server'],
  ['POST', /^\/api\/install\/framework$/, 'install', 'install_framework'],
  ['POST', /^\/api\/server\/(start|stop|restart|kill|restart-warned|save)$/, 'server.control', 'server_$1'],
  ['POST', /^\/api\/rcon$/, 'console', 'rcon'],
  ['POST', /^\/api\/say$/, 'players.kick', 'say'],
  ['POST', /^\/api\/players\/action$/, (req) => PA_PERM[req.body.action] || 'players.admin', 'player_$action'],
  ['POST', /^\/api\/players\/\d+\/inventory\/(remove|clear)$/, 'inventory.edit', 'inventory_$1'],
  ['POST', /^\/api\/watch\/(alerts|alerts-read|alerts-clear)/, 'watch.review', 'alerts'],
  ['POST', /^\/api\/steam\/check\//, 'watch.review', 'steam_check'],
  ['POST', /^\/api\/watch\/(bridge|test-discord)$/, 'watch.settings', 'watch_$1'],
  ['PUT', /^\/api\/(watch|steam)\/settings$/, 'watch.settings', '$1_settings'],
  ['PUT', /^\/api\/ipcheck$/, 'watch.settings', 'ipcheck_settings'],
  ['POST', /^\/api\/ipcheck\/test$/, 'watch.settings', null],
  ['POST', /^\/api\/teams\/refresh$/, 'view', null],
  ['POST', /^\/api\/map\/refresh$/, 'view', null],
  ['POST', /^\/api\/plugins\/(install|upload)$/, 'plugins', 'plugin_$1'],
  ['POST', /^\/api\/plugins\/[^/]+\/(enable|disable|reload)$/, 'plugins', 'plugin_$1'],
  ['DELETE', /^\/api\/plugins\//, 'plugins', 'plugin_delete'],
  ['PUT', /^\/api\/plugins\/[^/]+\/config$/, 'plugins', 'plugin_config'],
  ['POST', /^\/api\/perms$/, (req) => (req.body.action === 'show' ? 'view' : 'perms'), 'perm_$action'],
  ['POST', /^\/api\/backups$/, 'backups', 'backup_create'],
  ['POST', /^\/api\/backups\/[^/]+\/restore$/, 'backups', 'backup_restore'],
  ['DELETE', /^\/api\/backups\//, 'backups', 'backup_delete'],
  ['POST', /^\/api\/wipe$/, 'wipe', 'wipe'],
];
app.use('/api', (req, res, next) => {
  const full = '/api' + req.path;
  const rule = ACL.find(([m, re]) => m === req.method && re.test(full));
  if (!rule) return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
  const perm = typeof rule[2] === 'function' ? rule[2](req) : rule[2];
  const allowed = can(req.user, perm);
  if (req.method !== 'GET' && rule[3] && !(rule[3] === 'perm_$action' && req.body?.action === 'show')) {
    const m = full.match(rule[1]);
    const action = rule[3].replace('$1', m[1] || '').replace('$action', String(req.body?.action || '').replace(/[^\w-]/g, '')).replace(/-/g, '_');
    let target = (full.match(/\/(\d{17})(?:\/|$)/) || [])[1] || req.body?.steamid || (full.match(/^\/api\/(?:plugins|backups|users)\/([^/]+)/) || [])[1] || null;
    if (target && full.startsWith('/api/users/')) target = auth.listUsers().find(u => u.id === target)?.username || target;
    if (full === '/api/users') target = req.body?.username || null;
    const entry = { user: req.user.username, action, target: target ? decodeURIComponent(target) : null, details: audit.summarize(req.body), ip: req.socket.remoteAddress };
    if (!allowed) audit.record({ ...entry, ok: false, denied: true });
    else res.on('finish', () => audit.record({ ...entry, ok: res.statusCode < 400 }));
  }
  if (!allowed) return res.status(403).json({ error: i18n.tr('es', 'err.forbidden'), code: 'forbidden' });
  next();
});

// En modo remoto no hay archivos ni proceso: estas rutas no pueden funcionar
const REMOTE_BLOCK = [
  [/^POST$/, /^\/api\/install\//, 'remote_no_files'], [/^PUT$/, /^\/api\/platform$/, 'remote_no_files'],
  [/./, /^\/api\/plugins/, 'remote_no_files', 'files'], [/./, /^\/api\/backups/, 'remote_no_files'],
  [/^POST$/, /^\/api\/wipe$/, 'remote_no_files'], [/^POST$/, /^\/api\/server\/(start|kill)$/, 'remote_no_process'],
  [/^POST$/, /^\/api\/watch\/bridge$/, 'remote_bridge_manual', 'files'],
];
app.use('/api', (req, res, next) => {
  if (!config.isRemote()) return next();
  const full = '/api' + req.path;
  // Las marcadas con 'files' funcionan si el modo remoto tiene FTP/SFTP configurado
  const hit = REMOTE_BLOCK.find(([m, re, , needs]) => m.test(req.method) && re.test(full) && !(needs === 'files' && files.available()));
  if (!hit) return next();
  res.status(400).json({ error: i18n.tr('es', 'err.' + hit[2]), code: hit[2] });
});

// ---------- Administradores ----------
app.get('/api/me', h((req) => auth.me(req.user)));
app.get('/api/users', h(() => auth.listUsers()));
app.post('/api/users', h((req) => auth.createUser(req.body)));
app.put('/api/users/:id', h((req) => auth.updateUser(req.params.id, req.body, req.user)));
app.delete('/api/users/:id', h((req) => auth.deleteUser(req.params.id, req.user)));
app.get('/api/audit', h((req) => audit.list({ user: req.query.user, action: req.query.action, limit: parseInt(req.query.limit, 10) || 300 })));

app.post('/api/password', h((req) => auth.changeOwnPassword(req.user, req.body.current, req.body.password)));

app.get('/api/panel', h(() => {
  const p = config.get().panel;
  return { notifyLang: p.notifyLang || 'es', itemIcons: p.itemIcons ?? '' };
}));
// Plantilla de URL para las imágenes de los objetos ({shortname} se sustituye por el nombre interno)
app.put('/api/panel/icons', h((req) => {
  const url = String(req.body.itemIcons ?? '').trim();
  if (url && (url.length > 300 || !/^https?:\/\/[^\s"'<>]+$/i.test(url) || !url.includes('{shortname}'))) throw E('bad_icon_url');
  config.update('panel', { itemIcons: url });
  return { itemIcons: url };
}));
app.put('/api/panel', h((req) => {
  const lang = String(req.body.notifyLang || '');
  if (!i18n.available().some(l => l.code === lang)) throw E('bad_language');
  config.update('panel', { notifyLang: lang });
  return { notifyLang: lang }; // nunca devolver la sección completa (contiene el hash y el secreto de sesión)
}));

// ---------- Rates y modo de juego ----------
app.get('/api/rates', h(() => rates.view()));
app.put('/api/rates', h((req) => rates.update(req.body || {})));
app.put('/api/rates/mode', h((req) => rates.setMode(req.body?.pve === true)));
app.get('/api/world', h(() => world.view()));

// ---------- Estadísticas y planificador de wipes ----------
app.get('/api/stats', h((req) => stats.query(String(req.query.range || '7d'))));
app.get('/api/wipes', h(() => wipes.view()));
app.get('/api/perf', h(() => perf.view()));
app.get('/api/public', h(() => publicPage.settings()));
app.get('/api/discord', h(() => discordBot.view()));
app.put('/api/discord', h((req) => discordBot.update(req.body || {})));

// ---------- Tickets de reportes F7 ----------
app.get('/api/tickets', h((req) => tickets.list(String(req.query.status || 'active'))));
app.get('/api/tickets/:id', h((req) => tickets.get(req.params.id)));
app.post('/api/tickets/:id/assign', h((req) => tickets.assign(req.params.id, req.user.username, true)));
app.post('/api/tickets/:id/unassign', h((req) => tickets.assign(req.params.id, req.user.username, null)));
app.post('/api/tickets/:id/comment', h((req) => tickets.comment(req.params.id, req.user.username, req.body.text)));
app.post('/api/tickets/:id/reopen', h((req) => tickets.reopen(req.params.id, req.user.username)));
app.post('/api/tickets/:id/close', h((req) => tickets.close(req.params.id, req.user.username, req.body || {})));

// ---------- VIP con caducidad ----------
app.get('/api/vip', h(() => vip.view()));
app.post('/api/vip', h((req) => vip.grant(req.body || {}, req.user.username)));
app.delete('/api/vip/:id/:group', h((req) => vip.revoke(req.params.id, req.params.group, req.user.username)));
app.put('/api/vip', h((req) => vip.update(req.body || {})));

// ---------- Tienda (Tebex) ----------
// ---------- Servidor existente y modo remoto ----------
app.get('/api/import/browse', h((req) => importer.browse(req.query.dir ? String(req.query.dir) : '')));
app.post('/api/import/scan', h((req) => importer.scan(req.body?.dir)));
app.post('/api/import/apply', h((req) => importer.apply(req.body || {})));
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i;
function remoteInput(b, needPass) {
  const host = String(b.host || '').trim().replace(/^\[|\]$/g, '');
  const port = parseInt(b.rconPort, 10);
  if (!HOST_RE.test(host)) throw E('remote_bad_host');
  if (!(port >= 1 && port <= 65535)) throw E('field_port', { field: { k: 'cfg.rconPort' } });
  const password = String(b.rconPassword || '') || (needPass ? '' : config.get().remote.rconPassword);
  if (!password) throw E('remote_no_password');
  return { host, rconPort: port, rconPassword: password };
}
const remoteView = () => { const r = config.get().remote; return { enabled: config.isRemote(), host: r.host, rconPort: r.rconPort, hasPassword: !!r.rconPassword, files: files.available() }; };
app.get('/api/remote', h(() => remoteView()));
app.get('/api/remote/files', h(() => files.view()));

// ---------- Baneos compartidos ----------
app.get('/api/banlist', h(() => ({ ...banlist.view(), entries: banlist.entries() })));
app.put('/api/banlist', h((req) => banlist.update(req.body || {})));
app.put('/api/banlist/sources', h((req) => banlist.setSources(req.body.sources)));
app.post('/api/banlist/sources/test', h((req) => banlist.testSource(req.body.url)));
app.post('/api/banlist/keys', h((req) => banlist.addKey(req.body.name)));
app.post('/api/banlist/keys/:id/reveal', h((req) => banlist.revealKey(req.params.id)));
app.post('/api/banlist/keys/:id/rotate', h((req) => banlist.rotateKey(req.params.id)));
app.delete('/api/banlist/keys/:id', h((req) => banlist.removeKey(req.params.id)));
app.post('/api/banlist/bans', h((req) => banlist.addBan(req.body || {}, req.user?.username)));
app.delete('/api/banlist/bans/:id', h((req) => banlist.removeBan(req.params.id)));
app.get('/api/banlist/check/:id', h((req) => banlist.check(req.params.id)));
app.post('/api/remote/files/test', h((req) => files.test(req.body || {})));
app.put('/api/remote/files', h(async (req) => {
  const v = files.update(req.body || {});
  if (config.isRemote() && files.available()) watch.ensureBridge().then((u) => { if (u) { setTimeout(() => watch.checkBridge(), 8000); setTimeout(() => watch.checkBridge(), 18000); } }).catch(() => {});
  return v;
}));
app.post('/api/remote/test', h(async (req) => {
  const t = remoteInput(req.body || {}, false);
  const r = await rcon.probe({ host: t.host, port: t.rconPort, password: t.rconPassword }, 8000);
  if (!r.ok) throw E('remote_' + r.error);
  return { ok: true, hostname: r.info?.Hostname || '', players: r.info?.Players ?? null, maxPlayers: r.info?.MaxPlayers ?? null, map: r.info?.Map || '' };
}));
app.put('/api/remote', h(async (req) => {
  if (server.isManaged()) throw E('stop_before_remote');
  const t = remoteInput(req.body || {}, false);
  config.update('remote', t);
  config.update('server', { mode: 'remote' });
  log('panel', L('remote_enabled', { host: t.host }));
  server.reconnect();
  return remoteView();
}));
app.post('/api/remote/disable', h(() => {
  config.update('server', { mode: 'local' });
  log('panel', L('remote_disabled'));
  server.reconnect();
  return remoteView();
}));
// El complemento para subirlo a mano (modo remoto o servidores gestionados por otro panel)
app.get('/api/bridge/file', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="OxidianBridge.cs"');
  res.type('text/plain').sendFile(path.join(__dirname, 'lib', 'bridge', 'OxidianBridge.cs'));
});
app.get('/api/update', h(() => update.view()));
// Datos técnicos para reportar un fallo: sin IPs, rutas, nombres ni SteamIDs
app.get('/api/diag', h(() => {
  const st = server.getStatus(), bi = watch.bridgeInfo(), cfg = config.get().server;
  return {
    version: update.CURRENT, node: process.version, os: config.IS_WIN ? 'Windows' : 'Linux', osRelease: require('os').release(),
    serverPlatform: config.platformName(), framework: cfg.framework, branch: cfg.branch,
    bridge: bi.loaded ? (bi.version || '?') : bi.installed ? `installed ${bi.installedVersion || '?'}, not loaded` : 'none',
    bridgeError: bi.error ? String(bi.error).replace(/[A-Za-z]:\\[^\s:]+|\/(home|Users|root)\/[^\s:]+/g, '…').slice(0, 300) : null,
    status: st.status, rcon: rcon.isConnected(), worldSize: cfg.worldsize,
  };
}));
app.post('/api/update/check', h(() => update.check()));
app.put('/api/update', h((req) => update.setEnabled(!!req.body?.enabled)));
app.get('/api/store', h(() => store.view()));
app.put('/api/store', h((req) => store.update(req.body || {})));
app.post('/api/store/test', h((req) => store.test(req.body?.secret)));
app.post('/api/store/check', h(() => store.check({ force: true })));

// ---------- Staff en el juego ----------
app.get('/api/staff', h(() => staff.view()));
app.post('/api/staff', h((req) => staff.add(req.body || {}, req.user.username)));
app.post('/api/staff/sync', h(async () => { if (!await staff.sync()) throw E('bridge_missing'); return staff.view(); }));
app.delete('/api/staff/:id', h((req) => staff.remove(req.params.id, req.user.username)));
app.put('/api/public', h((req) => publicPage.update(req.body || {})));
app.put('/api/perf', h((req) => perf.update(req.body || {})));
app.put('/api/wipes', h((req) => wipes.update(req.body || {})));
app.post('/api/wipes/skip', h((req) => wipes.skip(String(req.body?.key || ''))));
app.post('/api/world/time', h((req) => world.setTime(req.body || {})));
app.post('/api/world/weather', h((req) => world.setWeather(String(req.body?.preset || ''))));
app.post('/api/world/event', h((req) => world.startEvent(String(req.body?.type || ''))));

// ---------- Estado ----------
app.get('/api/status', h(async () => {
  const st = server.getStatus();
  let info = null;
  if (rcon.isConnected()) info = await rcon.json('serverinfo').catch(() => null);
  if (info && st.status === 'starting') st.status = 'running';
  return {
    ...st,
    info,
    resources: server.resources(),
    installer: installer.state(),
    nextRestart: maint.nextRestart()?.getTime() || null,
    nextWipe: wipes.next()?.at || null,
    tickets: tickets.counts(),
    vipActive: vip.view().grants.length,
    platform: config.platformName(),          // plataforma de los archivos del servidor
    platformSetting: config.get().server.platform,
    hostPlatform: config.IS_WIN ? 'windows' : 'linux', // sistema donde corre el panel
  };
}));

// ---------- Configuración ----------
const SERVER_FIELDS = {
  platform: 'platform', branch: 'str', framework: null, identity: 'id', hostname: 'str', description: 'str', url: 'str', headerimage: 'str',
  port: 'port', queryPort: 'port', rconPort: 'port', rconPassword: 'str', appPort: 'port', maxplayers: 'int',
  level: 'str', worldsize: 'int', seed: 'int', saveinterval: 'int', tickrate: 'int', pve: 'bool',
  extraArgs: 'str', autostart: 'bool', autoRestartOnCrash: 'bool',
};
app.get('/api/config', h(() => ({ server: config.get().server, schedule: config.get().schedule, paths: config.get().paths, remote: remoteView() })));
app.put('/api/config/server', h((req) => {
  const clean = {};
  for (const [k, type] of Object.entries(SERVER_FIELDS)) {
    if (!(k in req.body) || type === null) continue;
    let v = req.body[k];
    if (type === 'int' || type === 'port') { v = parseInt(v, 10); if (Number.isNaN(v)) throw E('field_number', { field: { k: 'cfg.' + k } }); }
    if (type === 'port' && (v < 1 || v > 65535)) throw E('field_port', { field: { k: 'cfg.' + k } });
    if (type === 'bool') v = !!v;
    if (type === 'id' && !/^[\w-]{1,48}$/.test(v)) throw E('bad_identity');
    if (type === 'str') v = String(v);
    if (type === 'platform' && !['auto', 'windows', 'linux'].includes(v)) throw E('bad_platform');
    clean[k] = v;
  }
  if (clean.rconPassword !== undefined && clean.rconPassword.length < 6) throw E('rcon_password_short');
  if (clean.worldsize && (clean.worldsize < 1000 || clean.worldsize > 6000)) throw E('bad_worldsize');
  const out = config.update('server', clean);
  // En remoto no hay script de arranque: lo que se puede cambiar en caliente se manda por RCON y se guarda en server.cfg
  if (config.isRemote() && rcon.isConnected()) {
    const q = (v) => `"${String(v).replace(/"/g, "'")}"`;
    const live = { hostname: 'server.hostname', description: 'server.description', url: 'server.url', headerimage: 'server.headerimage', maxplayers: 'server.maxplayers' };
    (async () => {
      for (const [k, cv] of Object.entries(live)) if (clean[k] !== undefined) await rcon.command(`${cv} ${typeof clean[k] === 'number' ? clean[k] : q(clean[k])}`).catch(() => {});
      await rcon.command('server.writecfg').catch(() => {});
    })();
  }
  return out;
}));
app.put('/api/config/schedule', h((req) => {
  const b = req.body;
  const restarts = (b.restarts || []).filter(t => /^\d{1,2}:\d{2}$/.test(t));
  const announcements = (b.announcements || []).filter(a => a.message && a.intervalMinutes > 0)
    .map(a => ({ message: String(a.message), intervalMinutes: Math.max(1, parseInt(a.intervalMinutes, 10)) }));
  return config.update('schedule', {
    restarts, announcements,
    restartWarningMinutes: Math.min(60, Math.max(1, parseInt(b.restartWarningMinutes, 10) || 10)),
    autoUpdateOnRestart: !!b.autoUpdateOnRestart,
    autoBackupOnRestart: !!b.autoBackupOnRestart,
    keepBackups: Math.max(1, parseInt(b.keepBackups, 10) || 10),
  });
}));

// ---------- Instalación ----------
app.put('/api/platform', h((req) => {
  if (server.isRunning()) throw E('stop_before_platform');
  if (installer.state().busy) throw E('wait_install');
  const v = req.body.platform;
  if (!['auto', 'windows', 'linux'].includes(v)) throw E('bad_platform');
  config.update('server', { platform: v });
  log('panel', L('platform', { os: config.platformName() === 'windows' ? 'Windows' : 'Linux' }));
  return { platform: config.platformName(), platformSetting: v };
}));
app.post('/api/install/server', h((req) => {
  if (server.isRunning()) throw E('stop_before_install');
  installer.installServer({ validate: req.body.validate !== false }).catch(() => {});
  return { started: true };
}));
app.post('/api/install/framework', h((req) => {
  if (server.isRunning()) throw E('stop_before_framework');
  const fw = req.body.framework;
  installer.installFramework(fw)
    .then(() => { if (fw === 'oxide' || fw === 'carbon') return watch.installBridge(); })
    .catch(() => {});
  return { started: true };
}));

// ---------- Control del servidor ----------
app.post('/api/server/start', h(() => { if (installer.state().busy) throw E('wait_install'); server.start(); }));
app.post('/api/server/stop', h(async () => { await server.stop(); }));
app.post('/api/server/restart', h(async () => { await server.restart(); }));
app.post('/api/server/kill', h(() => server.kill()));
app.post('/api/server/restart-warned', h(async (req) => {
  const mins = Math.min(30, Math.max(1, parseInt(req.body.minutes, 10) || 5));
  if (!server.isRunning()) throw E('not_running');
  log('panel', L('warned_restart', { n: mins }));
  (async () => {
    for (let m = mins; m >= 1; m--) {
      await sayT(m > 1 ? 'game.restart_in_n' : 'game.restart_in_1', { n: m }).catch(() => {});
      await new Promise(r => setTimeout(r, 60000));
    }
    await server.restart().catch(e => log('panel', L('restart_failed', { error: errParam(e) })));
  })();
  return { scheduled: mins };
}));
app.post('/api/server/save', h(() => rcon.command('server.save', 60000)));

// ---------- Consola / RCON ----------
app.get('/api/console', (req, res) => res.json(consoleBuffer.slice(-500)));
app.post('/api/rcon', h(async (req) => {
  const cmd = String(req.body.command || '').trim();
  if (!cmd) throw E('empty_command');
  log('cmd', `> ${cmd}`);
  const out = await rcon.command(cmd);
  if (out) log('rcon', out);
  return { output: out };
}));
app.post('/api/say', h((req) => moderation.say(req.body.message || '', req.user.username)));

// ---------- Jugadores ----------
app.get('/api/players', h(async () => (await rcon.json('playerlist')) || []));
app.get('/api/bans', h(async () => {
  const out = await rcon.command('banlistex');
  // Formato: "1 76561198000000000 "nombre" "motivo" -1"
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^\d+\s+(\d{17})\s+"([^"]*)"\s+"([^"]*)"/);
    return m ? { steamid: m[1], name: m[2], reason: m[3] } : { raw: l };
  });
}));
app.get('/api/admins', h(async () => {
  const out = await rcon.command('moderatorlist').catch(() => '');
  return { raw: out };
}));
app.post('/api/players/action', h(async (req) => {
  const { action, reason = '', name = '', item, amount } = req.body;
  const id = steamId(req.body.steamid);
  const cmds = {
    kick: `kick ${id} ${q(reason || 'Expulsado por un administrador')}`,
    ban: `banid ${id} ${q(name)} ${q(reason || 'Baneado')}`,
    unban: `unban ${id}`,
    owner: `ownerid ${id} ${q(name)} ${q(reason || 'Panel')}`,
    moderator: `moderatorid ${id} ${q(name)} ${q(reason || 'Panel')}`,
    removeowner: `removeowner ${id}`,
    removemoderator: `removemoderator ${id}`,
    give: item && /^[\w.-]+$/.test(item) ? `inventory.giveto ${id} ${item} ${Math.max(1, parseInt(amount, 10) || 1)}` : null,
  };
  const cmd = cmds[action];
  if (!cmd) throw E('bad_action');
  log('cmd', `> ${cmd}`);
  const out = await rcon.command(cmd);
  if (action === 'ban') { watch.markBanned(id, true); await rcon.command(`kick ${id} ${q(reason || 'Baneado')}`).catch(() => {}); }
  if (action === 'unban') { watch.markBanned(id, false); moderation.clearTempban(id); }
  if (['ban', 'unban', 'owner', 'moderator', 'removeowner', 'removemoderator'].includes(action)) {
    await rcon.command('server.writecfg').catch(() => {});
  }
  return { output: out };
}));

// ---------- Inventario ----------
app.get('/api/players/:id/inventory', h((req) => watch.inventory(steamId(req.params.id))));
app.post('/api/players/:id/inventory/remove', h((req) => watch.removeItem(steamId(req.params.id), req.body.container, req.body.slot)));
app.post('/api/players/:id/inventory/clear', h((req) => watch.clearInventory(steamId(req.params.id))));

// ---------- Vigilancia ----------
app.get('/api/watch', h(() => watch.status()));
app.get('/api/watch/alerts', h((req) => watch.listAlerts({ status: req.query.status, severity: req.query.severity, steamid: req.query.steamid })));
app.post('/api/watch/alerts/:id', h((req) => {
  if (!['new', 'reviewed', 'dismissed'].includes(req.body.status)) throw E('bad_status');
  return watch.setStatus(req.params.id, req.body.status);
}));
app.post('/api/watch/alerts-read', h(() => watch.markAll()));
app.post('/api/watch/alerts-clear', h(() => watch.clearReviewed()));
app.get('/api/watch/suspects', h(() => watch.suspects()));
app.get('/api/watch/player/:id', h((req) => watch.playerInfo(steamId(req.params.id)) || { steamid: req.params.id, names: [], ips: [], alerts: [] }));
app.post('/api/watch/bridge', h(async () => {
  if (!['oxide', 'carbon'].includes(config.get().server.framework)) throw E('bridge_need_fw');
  await watch.installBridge();
  // Oxide/Carbon lo compilan en unos segundos; se comprueba dos veces por si tarda
  setTimeout(() => watch.checkBridge(), 6000); setTimeout(() => watch.checkBridge(), 15000);
  return watch.bridgeInfo();
}));
app.put('/api/watch/settings', h((req) => {
  const b = req.body, d = watch.DEFAULTS, num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const hook = String(b.discordWebhook || '').trim();
  if (hook && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook)) throw E('bad_webhook');
  return watch.update({
    enabled: !!b.enabled, sharedIp: !!b.sharedIp,
    headshotRatio: num(b.headshotRatio, d.headshotRatio, 0.2, 1),
    minHits: Math.round(num(b.minHits, d.minHits, 5, 200)),
    longShot: Math.round(num(b.longShot, d.longShot, 50, 2000)),
    shortWeaponShot: Math.round(num(b.shortWeaponShot, d.shortWeaponShot, 20, 1000)),
    killsPer10Min: Math.round(num(b.killsPer10Min, d.killsPer10Min, 2, 200)),
    violationsBurst: Math.round(num(b.violationsBurst, d.violationsBurst, 1, 100)),
    reportsForHigh: Math.round(num(b.reportsForHigh, d.reportsForHigh, 1, 20)),
    teamLimit: Math.round(num(b.teamLimit, 0, 0, 100)),
    cupboardGroups: !!b.cupboardGroups,
    discordWebhook: hook,
    discordMinSeverity: ['low', 'medium', 'high'].includes(b.discordMinSeverity) ? b.discordMinSeverity : 'medium',
  });
}));
app.post('/api/watch/test-discord', h(async (req) => {
  await watch.sendDiscord({ t: Date.now(), severity: 'low', code: 'test', params: {} }, String(req.body.webhook || '').trim());
}));

// ---------- Verificación en dos pasos ----------
app.post('/api/2fa/setup', h((req) => auth.setup2fa(req.user)));
app.post('/api/2fa/enable', h((req) => auth.enable2fa(req.user, req.body.code)));
app.post('/api/2fa/disable', h((req) => auth.disable2fa(req.user, req.body.password)));
app.post('/api/2fa/recovery', h((req) => auth.regenRecovery(req.user, req.body.password)));

// ---------- Chat y moderación ----------
app.get('/api/chat', h((req) => moderation.listChat({ q: req.query.q, steamid: req.query.steamid, ch: req.query.ch, limit: parseInt(req.query.limit, 10) || 300, before: parseInt(req.query.before, 10) || 0 })));
app.post('/api/chat/pm', h((req) => moderation.pm(steamId(req.body.steamid), req.body.message, req.user.username)));
app.get('/api/mod', h(() => ({ summary: moderation.summary(), active: moderation.active() })));
app.get('/api/mod/policy', h(() => moderation.settings().policy));
app.put('/api/mod/policy', h((req) => moderation.updatePolicy(req.body || {})));
app.get('/api/mod/filter', h(() => moderation.settings().filter));
app.put('/api/mod/filter', h((req) => moderation.updateFilter(req.body || {})));
app.get('/api/mod/:id', h((req) => moderation.player(steamId(req.params.id))));
app.post('/api/mod/:id/note', h((req) => moderation.addNote(steamId(req.params.id), req.body.text, req.user.username)));
app.delete('/api/mod/:id/note/:nid', h((req) => moderation.deleteNote(steamId(req.params.id), req.params.nid)));
app.post('/api/mod/:id/warn', h((req) => moderation.warn(steamId(req.params.id), { reason: req.body.reason, by: req.user.username, name: req.body.name })));
app.delete('/api/mod/:id/warn/:wid', h((req) => moderation.deleteWarning(steamId(req.params.id), req.params.wid)));
app.post('/api/mod/:id/mute', h((req) => moderation.mute(steamId(req.params.id), { minutes: req.body.minutes, reason: req.body.reason, by: req.user.username, name: req.body.name })));
app.post('/api/mod/:id/unmute', h((req) => moderation.unmute(steamId(req.params.id))));
app.post('/api/mod/:id/tempban', h((req) => moderation.tempban(steamId(req.params.id), { minutes: req.body.minutes, reason: req.body.reason, by: req.user.username, name: req.body.name })));

// ---------- Steam ----------
app.get('/api/steam/settings', h(() => steam.publicSettings()));
app.put('/api/steam/settings', h((req) => steam.update(req.body || {})));
app.get('/api/ipcheck', h(() => ipcheck.publicSettings()));
app.put('/api/ipcheck', h((req) => ipcheck.update(req.body || {})));
app.post('/api/ipcheck/test', h(async (req) => { const r = await ipcheck.lookup(String(req.body?.ip || ''), { force: true }); return { result: r, findings: ipcheck.evaluate(r) }; }));
app.post('/api/steam/check/:id', h((req) => watch.checkSteamNow(steamId(req.params.id))));

// ---------- Equipos ----------
app.get('/api/teams', h(() => watch.teamsView()));
app.post('/api/teams/refresh', h(async () => { await watch.pollTeams(); return watch.teamsView(); }));

// ---------- Mapa en vivo ----------
app.get('/api/map', h(() => liveMap.meta()));
app.post('/api/map/refresh', h(() => liveMap.meta({ refresh: true })));
app.get('/api/map/image', (req, res) => {
  try { res.set('Cache-Control', 'no-cache'); res.sendFile(liveMap.imagePath()); } catch (e) { res.status(404).json({ error: e.message, code: e.code }); }
});
app.get('/api/map/positions', h(() => liveMap.positions()));

// ---------- Plugins ----------
app.get('/api/plugins', h(() => plugins.list()));
app.get('/api/plugins/search', h((req) => plugins.searchUmod(req.query.q || '', parseInt(req.query.page, 10) || 1, req.query.sort || 'downloads')));
app.get('/api/plugins/updates', h(() => plugins.checkUpdates()));
app.post('/api/plugins/install', h((req) => plugins.installFromUmod(req.body.name, req.body.downloadUrl)));
app.post('/api/plugins/upload', h((req) => {
  const name = path.basename(String(req.body.filename || ''), '.cs');
  return plugins.writePlugin(name, String(req.body.source || ''));
}));
app.post('/api/plugins/:name/enable', h((req) => plugins.setEnabled(req.params.name, true)));
app.post('/api/plugins/:name/disable', h((req) => plugins.setEnabled(req.params.name, false)));
app.post('/api/plugins/:name/reload', h(async (req) => ({ output: await plugins.reload(req.params.name) })));
app.delete('/api/plugins/:name', h((req) => plugins.remove(req.params.name, { purgeData: req.query.purge === '1' })));
app.get('/api/plugins/:name/config', h(async (req) => ({ text: await plugins.getConfig(req.params.name) })));
app.put('/api/plugins/:name/config', h((req) => plugins.saveConfig(req.params.name, String(req.body.text || ''))));

// ---------- Permisos (Oxide / Carbon) ----------
app.post('/api/perms', h(async (req) => {
  const { action, type, target, perm } = req.body;
  const pre = plugins.dirs().cmd;
  const safe = (s) => { if (!/^[\w.\-:]+$/.test(s || '')) throw E('bad_value', { value: s || '' }); return s; };
  let cmd;
  if (action === 'grant' || action === 'revoke') cmd = `${pre}${action} ${type === 'group' ? 'group' : 'user'} ${safe(target)} ${safe(perm)}`;
  else if (action === 'addgroup') cmd = `${pre}group add ${safe(target)}`;
  else if (action === 'removegroup') cmd = `${pre}group remove ${safe(target)}`;
  else if (action === 'usergroup-add') cmd = `${pre}usergroup add ${safe(target)} ${safe(perm)}`;
  else if (action === 'usergroup-remove') cmd = `${pre}usergroup remove ${safe(target)} ${safe(perm)}`;
  else if (action === 'show') cmd = `${pre}show ${['perms', 'groups', 'user', 'group', 'perm'].includes(type) ? type : 'perms'}${target ? ' ' + safe(target) : ''}`;
  else throw E('bad_action');
  log('cmd', `> ${cmd}`);
  return { output: await rcon.command(cmd) };
}));

// ---------- Copias de seguridad y wipe ----------
app.get('/api/backups', h(() => maint.listBackups()));
app.post('/api/backups', h(async () => ({ name: await maint.createBackup('manual') })));
app.delete('/api/backups/:name', h((req) => maint.deleteBackup(req.params.name)));
app.post('/api/backups/:name/restore', h((req) => maint.restoreBackup(req.params.name)));
app.get('/api/backups/:name/download', (req, res) => {
  try { res.download(maint.safeBackupPath(req.params.name)); } catch (e) { res.status(404).json({ error: e.message, code: e.code }); }
});
app.post('/api/wipe', h(async (req) => {
  const r = await maint.wipe(req.body || {});
  wipes.recordManual(r, !!req.body?.blueprints);
  return r;
}));

// Errores no capturados (p. ej. JSON mal formado) siempre como JSON
app.use((err, req, res, next) => {
  res.status(err.status || 500).json(err.type === 'entity.parse.failed' ? { error: 'JSON', code: 'bad_request_json' } : { error: err.message, code: err.code });
});

// ---------- HTTP + WebSocket ----------
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !auth.verifyToken(auth.tokenFromReq(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
bus.on('console', (e) => broadcast('console', e));
bus.on('status', (s) => broadcast('status', s));
bus.on('installer', (e) => broadcast('installer', e));
bus.on('rcon', (e) => broadcast('rcon', e));
bus.on('perf', (e) => broadcast('perf', e));
bus.on('tickets', (e) => broadcast('tickets', e));
bus.on('vip', (e) => broadcast('vip', e));
bus.on('store', (e) => broadcast('store', e));
bus.on('update', (e) => broadcast('update', e));
bus.on('banlist', (e) => broadcast('banlist', e));
bus.on('alert', (a) => broadcast('alert', a));
bus.on('progress', (p) => broadcast('progress', p));
bus.on('chatmsg', (m) => broadcast('chatmsg', m));

const port = process.env.PORT || config.get().panel.port;
httpServer.listen(port, () => {
  console.log(`\n  Oxidian v${update.CURRENT} escuchando en http://localhost:${port}`);
  if (!auth.isSetup()) console.log('  Primer arranque: abre el panel en el navegador para crear el usuario propietario.\n');
  log('panel', L('panel_started', { port }));
  maint.startScheduler();
  watch.start();
  moderation.start();
  rates.start();
  stats.start();
  wipes.start();
  perf.start();
  tickets.start();
  vip.start();
  store.start();
  update.start();
  server.watchExternal();
  staff.start();
  banlist.start();
  discordBot.start();
  if (!config.isRemote() && config.get().server.autostart && fs.existsSync(config.serverPaths().exe)) {
    // Si el servidor ya está encendido (arrancado fuera del panel) no se lanza otro: se adopta
    rcon.probe({ ...config.rconTarget() }, 3000).then((r) => {
      if (r.ok) return;
      try { server.start(); } catch (e) { log('panel', L('autostart_failed', { error: errParam(e) })); }
    });
  }
});

// Parada ordenada del servidor de Rust al cerrar el panel
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\nCerrando panel...');
    if (server.isRunning()) { console.log('Guardando y deteniendo el servidor de Rust...'); await server.stop({ timeoutSec: 60 }); }
    process.exit(0);
  });
}
