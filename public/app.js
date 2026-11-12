// Scrapwarden: frontend sin dependencias
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const state = {
  status: {}, config: null, view: 'dashboard',
  consoleLines: [], plugins: [], updates: {}, progress: null,
  history: { players: [], fps: [], cpu: [], ram: [] },
  alertFilter: 'new', unreadAlerts: 0, me: null,
};
const can = (perm) => !perm || !!state.me?.perms.includes(perm);

// Oculta o desactiva lo que el usuario no puede usar según su rol
function applyPerms(root = document) {
  $$('[data-perm]', root).forEach(el => { el.hidden = !can(el.dataset.perm); });
  $$('[data-perm-any]', root).forEach(el => { el.hidden = !el.dataset.permAny.split(',').some(can); });
  $$('[data-perm-form]', root).forEach(el => {
    const ok = can(el.dataset.permForm);
    $$('input, select, textarea, button', el).forEach(c => { if (!c.closest('[data-perm-free]')) c.disabled = !ok || c.dataset.lockedBy === 'state'; });
    $$('.savebar', el).forEach(b => { b.hidden = !ok; });
    el.classList.toggle('is-readonly', !ok);
  });
}
const HISTORY_MAX = 60; // 5 min a 5 s por muestra

// ======================================================================
// Idiomas
// ======================================================================
const LOCALES = { es: 'es-ES', en: 'en-GB', pt: 'pt-BR', fr: 'fr-FR' };
let LANG = 'es', STR = {}, BASE = {}, WIKI = [], LANGS = [];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function fetchLang(code) {
  const r = await fetch(`i18n/${code}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('lang ' + code);
  return r.json();
}

// Traduce una clave. Los parámetros pueden ser { k, p } (se traducen a su vez)
function t(key, params = {}) {
  const s = STR[key] ?? BASE[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    if (v === undefined || v === null) return m;
    if (typeof v === 'object' && v.k) return t(v.k, v.p || {});
    return typeof v === 'number' ? fmtNum(v) : String(v);
  });
}
// Plural simple: clave_one / clave_other
const tn = (key, n, params = {}) => t(`${key}_${n === 1 ? 'one' : 'other'}`, { n, ...params });

function applyI18n(root = document) {
  $$('[data-i18n]', root).forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]', root).forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$('[data-i18n-ph]', root).forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]', root).forEach(el => { el.title = t(el.dataset.i18nTitle); });
  $$('[data-i18n-aria]', root).forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.documentElement.lang = LANG;
}

async function setLanguage(code, { save = true } = {}) {
  if (!LANGS.some(l => l.code === code)) code = 'es';
  const j = await fetchLang(code);
  if (!Object.keys(BASE).length) BASE = code === 'es' ? j.strings : (await fetchLang('es')).strings;
  LANG = code; STR = j.strings; WIKI = j.wiki || [];
  if (save) store.set('rp_lang', code);
  $$('.langSel').forEach(s => { s.value = code; });
  applyI18n();
}

async function initLanguages() {
  try { LANGS = await (await fetch('/api/languages')).json(); } catch { LANGS = [{ code: 'es', name: 'Español' }]; }
  const opts = LANGS.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  $$('.langSel').forEach(s => { s.innerHTML = opts; });
  const nav = (navigator.language || 'es').slice(0, 2);
  const initial = store.get('rp_lang') || (LANGS.some(l => l.code === nav) ? nav : 'es');
  await setLanguage(initial, { save: false });
  $$('.langSel').forEach(s => s.onchange = async () => {
    await setLanguage(s.value);
    rerenderAll();
  });
}

// Vuelve a pintar todo lo que se genera desde JS tras cambiar de idioma
function rerenderAll() {
  if ($('#app').hidden) { showAuth(setupMode); return; }
  document.title = `${t('nav.' + state.view)} | Scrapwarden`;
  renderStatus();
  renderProgress();
  renderUpdate(state.update);
  if (state.me) { $('#meRole').textContent = t('role.' + state.me.role); applyPerms(); }
  go(state.view);
}

// ======================================================================
// API y utilidades
// ======================================================================
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !['/login', '/setup'].includes(path)) { showAuth(false); throw new Error(t('err.session_expired')); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.code ? t('err.' + data.code, data.params || {}) : (data.error || `Error ${res.status}`));
  return data;
}

function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' toast--error' : '');
  el.innerHTML = ic(error ? 'alert' : 'check') + `<span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, error ? 6500 : 3500);
}

async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; } catch (e) { toast(e.message, true); return null; }
}

const locale = () => LOCALES[LANG] || LANG;
function fmtNum(n) { return Number(n || 0).toLocaleString(locale()); }
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return t('time.dh', { d, h });
  if (h) return t('time.hm', { h, m });
  if (m) return t('time.m', { m });
  return t('time.s', { s: sec });
}
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toLocaleString(locale(), { maximumFractionDigits: 2 }) + ' GB' : b >= 1e6 ? (b / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDate = (ts) => new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(locale());
const osName = (p) => p === 'windows' ? 'Windows' : 'Linux';
const msgText = (m) => (m && typeof m === 'object' && m.k ? t(m.k, m.p || {}) : String(m ?? ''));

// ======================================================================
// Diálogos
// ======================================================================
let dialogResolve = null;
function openDialog({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $('.dialog').classList.toggle('dialog--wide', wide);
    $('#dialogTitle').textContent = title;
    $('#dialogBody').innerHTML = body;
    $('#dialogFoot').innerHTML = '<p class="form-error" id="dialogErr"></p>' + actions.map((a, i) =>
      `<button class="btn ${a.cls || ''}" data-dlg="${i}">${esc(a.label)}</button>`).join('');
    $$('#dialogFoot [data-dlg]').forEach(b => b.onclick = () => {
      const a = actions[+b.dataset.dlg];
      if (a.validate) { const err = a.validate(); if (err) { $('#dialogErr').textContent = err; return; } }
      closeDialog(a.value !== undefined ? a.value : (a.get ? a.get() : true));
    });
    $('#dialog').hidden = false;
    const first = $('#dialogBody input:not([type=checkbox]), #dialogBody textarea') || $('#dialogFoot .btn:last-child');
    setTimeout(() => first?.focus(), 30);
  });
}
function closeDialog(value = null) {
  $('#dialog').hidden = true;
  const r = dialogResolve; dialogResolve = null;
  r?.(value);
}
$('#dialogClose').onclick = () => closeDialog(null);
$('#dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'dialog') closeDialog(null); });
document.addEventListener('keydown', (e) => {
  if ($('#dialog').hidden) return;
  if (e.key === 'Escape') closeDialog(null);
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); $('#dialogFoot .btn:last-child').click(); }
});
const cancelAct = () => ({ label: t('common.cancel'), cls: 'btn-quiet', value: null });
const confirmDialog = ({ title, body, confirm, danger = false }) => openDialog({
  title, body: `<p>${body}</p>`,
  actions: [{ ...cancelAct(), value: false }, { label: confirm || t('common.confirm'), cls: danger ? 'btn-danger' : 'btn-primary', value: true }],
});
const promptDialog = ({ title, label, placeholder = '', value = '', confirm, danger = false }) => openDialog({
  title, body: `<label class="field"><span>${esc(label)}</span><input id="dlgInput" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>`,
  actions: [cancelAct(), { label: confirm || t('common.ok'), cls: danger ? 'btn-danger' : 'btn-primary', get: () => $('#dlgInput').value }],
});

// ======================================================================
// Acceso
// ======================================================================
let setupMode = false;
function showAuth(setup) {
  setupMode = setup;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth2fa').hidden = true; $('#authForm').hidden = false;
  $('#authPw2Wrap').hidden = !setup;
  $('#authPw2').required = setup;
  $('#authTitle').textContent = t(setup ? 'auth.setupTitle' : 'auth.loginTitle');
  $('#authHint').textContent = t(setup ? 'auth.setupHint' : 'auth.loginHint');
  $('#authBtn').textContent = t(setup ? 'auth.setupBtn' : 'auth.loginBtn');
  $('#authPw').autocomplete = setup ? 'new-password' : 'current-password';
  if (!setup && !$('#authUser').value) $('#authUser').value = store.get('rp_user') || '';
  setTimeout(() => ($('#authUser').value ? $('#authPw') : $('#authUser')).focus(), 30);
}
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  const pw = $('#authPw').value;
  try {
    if (setupMode) {
      if (pw.length < 8) throw new Error(t('err.password_short'));
      if (pw !== $('#authPw2').value) throw new Error(t('auth.mismatch'));
      await api('/setup', { body: { username: $('#authUser').value.trim(), password: pw } });
    } else {
      const r = await api('/login', { body: { username: $('#authUser').value.trim(), password: pw } });
      if (r.need2fa) {
        state.ticket = r.ticket;
        store.set('rp_user', $('#authUser').value.trim());
        $('#authForm').hidden = true; $('#auth2fa').hidden = false; $('#tfaErr').textContent = '';
        $('#tfaCode').value = ''; setTimeout(() => $('#tfaCode').focus(), 30);
        return;
      }
    }
    store.set('rp_user', $('#authUser').value.trim());
    $('#authPw').value = $('#authPw2').value = '';
    sfx.play();
    boot();
  } catch (err) { $('#authErr').textContent = err.message; }
};
$('#auth2fa').onsubmit = async (e) => {
  e.preventDefault();
  $('#tfaErr').textContent = '';
  try {
    await api('/login/2fa', { body: { ticket: state.ticket, code: $('#tfaCode').value.trim() } });
    state.ticket = null; $('#authPw').value = '';
    $('#auth2fa').hidden = true; $('#authForm').hidden = false;
    sfx.play();
    boot();
  } catch (err) {
    $('#tfaErr').textContent = err.message;
    if (/expir/i.test(err.message) || err.message === t('err.twofa_expired')) setTimeout(() => $('#tfaBack').click(), 1500);
  }
};
$('#tfaBack').onclick = () => { state.ticket = null; $('#auth2fa').hidden = true; $('#authForm').hidden = false; $('#authPw').value = ''; $('#authPw').focus(); };
$('#logoutBtn').onclick = async () => { await api('/logout', { body: {} }).catch(() => {}); location.reload(); };

// ======================================================================
// Navegación
// ======================================================================
const VIEWS = ['dashboard', 'stats', 'perf', 'console', 'chat', 'map', 'players', 'watch', 'tickets', 'bans', 'vip', 'store', 'staff', 'plugins', 'perms', 'config', 'rates', 'schedule', 'wipes', 'public', 'discord', 'backups', 'install', 'admins', 'wiki', 'settings'];
function go(view) {
  if (!VIEWS.includes(view) || (view === 'admins' && !can('users') && !can('audit'))) view = 'dashboard';
  if (state.view === 'map' && view !== 'map') mapStop();
  state.view = view;
  $$('.rail a[data-view]').forEach(a => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $$('[data-section]').forEach(s => s.hidden = s.dataset.section !== view);
  document.title = `${t('nav.' + view)} | Scrapwarden`;
  history.replaceState(null, '', '#' + view);
  $('#rail').classList.remove('open');
  const loaders = { dashboard: renderMini, console: renderConsole, players: loadPlayers, watch: loadWatch, plugins: loadPlugins, config: loadConfig, schedule: loadConfig, rates: loadRates, stats: loadStats, wipes: loadWipes, perf: loadPerf, public: loadPublic, discord: loadDiscord, tickets: loadTickets, bans: loadBans, vip: loadVip, store: loadStore, staff: loadStaff, backups: loadBackups, install: loadInstall, wiki: renderWiki, settings: loadAccount, map: mapStart, admins: loadAdmins, chat: loadChat };
  loaders[view]?.();
}
$$('.rail a[data-view]').forEach(a => { a.href = '#' + a.dataset.view; a.onclick = (e) => { e.preventDefault(); go(a.dataset.view); }; });
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); if (!$('#dialog').hidden) closeDialog(); go(g.dataset.goto); } });
$('#railToggle').onclick = () => $('#rail').classList.toggle('open');

// ======================================================================
// Control del servidor
// ======================================================================
$$('[data-act]').forEach(b => b.onclick = async () => {
  const a = b.dataset.act;
  const rm = isRemoteMode();
  if (a === 'stop' && !await confirmDialog({ title: t('act.stopTitle'), body: t(rm ? 'act.stopBodyRemote' : 'act.stopBody'), confirm: t('act.stop'), danger: true })) return;
  if (a === 'restart' && !await confirmDialog({ title: t('act.restartTitle'), body: t(rm ? 'act.restartBodyRemote' : 'act.restartBody'), confirm: t('act.restart') })) return;
  if (a === 'kill' && !await confirmDialog({ title: t('dash.kill'), body: t('act.killBody'), confirm: t('dash.kill'), danger: true })) return;
  if (a === 'stop' || a === 'restart') toast(t(a === 'stop' ? 'act.stopping' : 'act.restarting'));
  await act(() => api('/server/' + a, { body: {} }), t('act.done.' + a));
  refreshStatus();
});
$('#saveBtn').onclick = () => act(() => api('/server/save', { body: {} }), t('dash.saved'));
$('#quickSayForm').onsubmit = async (e) => {
  e.preventDefault();
  const m = $('#quickSay').value.trim(); if (!m) return;
  if (await act(() => api('/say', { body: { message: m } }), t('dash.sent'))) $('#quickSay').value = '';
};
$('#warnRestartBtn').onclick = async () => {
  const m = +$('#warnMins').value;
  if (!await confirmDialog({ title: t('dash.warned'), body: t('dash.warnedBody', { n: m }), confirm: t('dash.warnedConfirm') })) return;
  act(() => api('/server/restart-warned', { body: { minutes: m } }), t('dash.warnedDone', { n: m }));
};
$('#srvAddr').onclick = async () => {
  try { await navigator.clipboard.writeText($('#srvAddrText').textContent); toast(t('srv.copied')); }
  catch { toast(t('common.copyFailed'), true); }
};

// ======================================================================
// Estado y telemetría
// ======================================================================
async function refreshStatus() {
  try {
    const s = await api('/status');
    state.status = s;
    if (s.installer?.progress !== undefined) state.progress = s.installer.progress;
    sample(s);
    renderStatus();
    renderProgress();
  } catch {}
}

function sample(s) {
  const h = state.history, i = s.info, r = s.resources;
  const push = (k, v) => { h[k].push(v); if (h[k].length > HISTORY_MAX) h[k].shift(); };
  if (s.status === 'stopped') { for (const k in h) h[k] = []; return; }
  push('players', i ? i.Players : null);
  if (state.view === 'chat' && s.rcon) api('/players').then(l => { state.chatOnline = l; updateTargets(); }).catch(() => {});
  push('fps', i ? i.Framerate : null);
  push('cpu', r ? r.cpu : null);
  push('ram', r ? r.ramMB / 1024 : (i ? i.Memory / 1024 : null));
}

function spark(svg, values) {
  const pts = values.map((v, i) => [i, v]).filter(p => p[1] !== null && !Number.isNaN(p[1]));
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const W = 300, H = 46, pad = 4;
  const max = Math.max(...pts.map(p => p[1])), min = Math.min(...pts.map(p => p[1]));
  const span = max - min || Math.max(1, max * .1);
  const win = Math.max(12, values.length);
  const x = (i) => (i / (win - 1)) * W;
  const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
  const offset = win - values.length;
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0] + offset).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1][0] + offset).toFixed(1)},${H} L${x(pts[0][0] + offset).toFixed(1)},${H} Z`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<path class="area" d="${area}"/><path class="line" d="${line}"/>`;
}

const FW_LABEL = { none: 'Vanilla', oxide: 'Oxide', carbon: 'Carbon' };

function renderStatus() {
  const s = state.status, i = s.info, cfg = state.config?.server;
  if (!s.status) return;
  $('#lamp').dataset.state = s.status;
  $('#srvState').textContent = t('status.' + s.status);
  $('#srvUptime').textContent = s.startedAt ? t('srv.uptime', { d: fmtDur((Date.now() - s.startedAt) / 1000) }) : (s.installed === false ? t('srv.notInstalled') : '');
  $('#srvName').textContent = i?.Hostname || cfg?.hostname || t('srv.defaultName');
  $('#srvAddrText').textContent = `client.connect ${s.mode === 'remote' && s.remoteHost ? s.remoteHost : (location.hostname || 'localhost')}:${cfg?.port || 28015}`;
  $('#srvMap').textContent = cfg ? (['Procedural Map', 'Barren'].includes(cfg.level) ? `${cfg.level} ${cfg.worldsize}` : cfg.level) : '';
  $('#srvFw').textContent = s.mode === 'remote' ? t('srv.remoteOn', { fw: FW_LABEL[s.framework] || '', host: s.remoteHost || '' }) : s.platform ? t('srv.fwOn', { fw: FW_LABEL[s.framework] || '', os: osName(s.platform) }) + (s.attached ? ' · ' + t('srv.external') : '') : '';
  const mc = $('#srvMode');
  if (s.pve !== undefined) {
    mc.hidden = false; mc.dataset.mode = s.pve ? 'pve' : 'pvp';
    mc.textContent = (s.pve ? 'PvE' : 'PvP') + (s.gatherRate && s.gatherRate !== 1 ? ` · ${fmtX(s.gatherRate)}` : '');
    mc.title = t('rt.chipTitle');
  }
  if (s.tickets) setTicketBadge(s.tickets);
  if (s.vipActive !== undefined) $('#navVip').textContent = s.vipActive || '';
  const wc = $('#srvWipe');
  wc.hidden = !s.nextWipe;
  if (s.nextWipe) { wc.textContent = t('wp.chip', { d: fmtDur((s.nextWipe - Date.now()) / 1000) }); wc.title = new Date(s.nextWipe).toLocaleString(locale()); }

  const running = s.status !== 'stopped';
  $('[data-act=start]').disabled = running || !s.installed || !!s.installer?.busy;
  $('[data-act=stop]').disabled = !running;
  $('[data-act=restart]').disabled = !running;
  $$('#saveBtn, #warnRestartBtn, #quickSayForm button').forEach(b => b.disabled = !s.rcon || (b.closest('#quickSayForm') ? !can('players.kick') : !can('server.control')));
  $('.op--danger').disabled = !running;
  applyMode();
  $('#wipeBtn').disabled = running;
  $('#wipeBtn').title = running ? t('bk.stopFirst') : '';
  $('#navPlayers').textContent = i ? i.Players : '';

  const h = state.history;
  $('#mPlayers').innerHTML = i ? `${fmtNum(i.Players)}<small>/ ${fmtNum(i.MaxPlayers)}</small>` : '—';
  $('#mPlayersSub').textContent = i ? (i.Queued || i.Joining ? t('dash.queue', { q: i.Queued, j: i.Joining }) : t('dash.noQueue')) : (running ? t('dash.waitRcon') : '');
  $('#mFps').textContent = i ? i.Framerate : '—';
  $('#mFpsSub').textContent = i ? t('dash.entities', { n: i.EntityCount }) : '';
  $('#mFpsSub').classList.toggle('warn', !!i && i.Framerate < 20);
  $('[data-metric=fps]').dataset.tone = i && i.Framerate < 20 ? 'warn' : '';
  $('#mCpu').innerHTML = s.resources ? `${s.resources.cpu}<small>%</small>` : '—';
  $('#mCpuSub').textContent = s.resources ? t('dash.cpuSub') : '';
  const ramGB = s.resources ? s.resources.ramMB / 1024 : i ? i.Memory / 1024 : null;
  $('#mRam').innerHTML = ramGB !== null ? `${ramGB.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })}<small>GB</small>` : '—';
  $('#mRamSub').textContent = s.resources ? t('dash.ramSub') : i ? t('dash.ramUnity') : '';
  for (const k of ['players', 'fps', 'cpu', 'ram']) spark($(`[data-metric=${k}] .spark`), h[k]);

  const rows = i ? [
    [t('info.map'), i.Map], [t('info.gameTime'), i.GameTime], [t('info.uptime'), fmtDur(i.Uptime)],
    [t('info.net'), t('info.netVal', { i: Math.round(i.NetworkIn / 1024), o: Math.round(i.NetworkOut / 1024) })],
    [t('info.lastSave'), i.SaveCreatedTime ? fmtDate(i.SaveCreatedTime) : '—'],
  ] : [[t('info.installed'), t(s.installed ? 'common.yes' : 'common.no')], ['RCON', t(s.rcon ? 'info.connected' : 'info.disconnected')]];
  rows.push([t('info.framework'), FW_LABEL[s.framework] || '—']);
  rows.push([t('info.nextRestart'), s.nextRestart ? fmtDate(s.nextRestart) : t('info.none')]);
  $('#infoList').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');

  if (state.view === 'install') renderInstallState();
}

// ======================================================================
// Progreso de instalación
// ======================================================================
const progSamples = [];
function onProgress(p) {
  if (p && (!state.progress || state.progress.task !== p.task)) progSamples.length = 0;
  state.progress = p;
  if (p) { progSamples.push({ t: Date.now(), v: p.overall }); if (progSamples.length > 40) progSamples.shift(); }
  renderProgress();
}
function eta() {
  if (progSamples.length < 5) return null;
  const a = progSamples[0], b = progSamples[progSamples.length - 1];
  const rate = (b.v - a.v) / ((b.t - a.t) / 1000); // % por segundo
  if (rate <= 0.001) return null;
  return (100 - b.v) / rate;
}
function renderProgress() {
  const p = state.progress;
  const busy = !!p;
  $('#srvProgress').hidden = !busy;
  $('#navInstall').textContent = busy ? `${Math.floor(p.overall)} %` : '';
  $('#progressCard').hidden = !busy;
  if (!busy) return;
  const pct = Math.floor(p.overall);
  $('#srvProgressFill').style.width = p.overall + '%';
  $('#srvProgressText').textContent = t('prog.short', { task: { k: 'task.' + p.task }, pct });
  $('#progTask').textContent = t('task.' + p.task);
  $('#progPhase').textContent = t('phase.' + p.phase) + (p.phase !== 'starting' ? ` · ${Math.floor(p.pct)} %` : '');
  $('#progPct').textContent = `${pct} %`;
  $('#progFill').style.width = p.overall + '%';
  $('#progBar').setAttribute('aria-valuenow', pct);
  $('#progBar').classList.toggle('is-indeterminate', p.phase === 'starting');
  $('#progDetail').textContent = p.total ? t('prog.bytes', { done: fmtSize(p.done), total: fmtSize(p.total) }) : '';
  const e = eta();
  $('#progEta').textContent = e ? t('prog.eta', { d: fmtDur(e) }) : '';
}

// ======================================================================
// Consola
// ======================================================================
function lineHtml(e) {
  const text = e.k ? t(e.k, e.p || {}) : e.line;
  let cls = 'src-' + e.source;
  if (e.source === 'server') {
    if (/exception|error|failed/i.test(text)) cls += ' is-error';
    else if (/warn/i.test(text)) cls += ' is-warn';
  }
  return `<div class="ln ${cls}"><span class="t">${fmtTime(e.t)}</span><span>${esc(text)}</span></div>`;
}
function consoleVisible(e) {
  if (e.source === 'server' && !$('#fServer').checked) return false;
  if (e.source === 'chat' && !$('#fChat').checked) return false;
  if (['panel', 'installer', 'watch'].includes(e.source) && !$('#fPanel').checked) return false;
  const f = $('#consoleFilter').value.toLowerCase();
  return !f || (e.k ? t(e.k, e.p || {}) : e.line).toLowerCase().includes(f);
}
function renderConsole() {
  const el = $('#console');
  const lines = state.consoleLines.filter(consoleVisible).slice(-800);
  el.innerHTML = lines.length ? lines.map(lineHtml).join('') : `<div class="ln src-panel">${esc(t('con.empty'))}</div>`;
  if ($('#fAuto').checked) el.scrollTop = el.scrollHeight;
}
function renderMini() {
  const el = $('#miniConsole');
  const lines = state.consoleLines.filter(e => e.source !== 'installer').slice(-40);
  el.innerHTML = lines.length ? lines.map(lineHtml).join('') : `<div class="ln src-panel">${esc(t('con.emptyShort'))}</div>`;
  el.scrollTop = el.scrollHeight;
}
function pushConsole(e) {
  state.consoleLines.push(e);
  if (state.consoleLines.length > 2000) state.consoleLines.shift();
  if (state.view === 'console' && consoleVisible(e)) {
    const el = $('#console');
    if (el.querySelector('.src-panel:only-child')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', lineHtml(e));
    if ($('#fAuto').checked) el.scrollTop = el.scrollHeight;
  }
  if (state.view === 'dashboard' && e.source !== 'installer') renderMini();
}
['#fServer', '#fChat', '#fPanel'].forEach(s => $(s).onchange = renderConsole);
$('#consoleFilter').oninput = renderConsole;

const cmdHistory = []; let hIdx = -1;
$('#rconForm').onsubmit = async (e) => {
  e.preventDefault();
  const cmd = $('#rconInput').value.trim(); if (!cmd) return;
  cmdHistory.unshift(cmd); hIdx = -1;
  $('#rconInput').value = '';
  await act(() => api('/rcon', { body: { command: cmd } }));
};
$('#rconInput').onkeydown = (e) => {
  if (e.key === 'ArrowUp' && cmdHistory[hIdx + 1] !== undefined) { hIdx++; e.target.value = cmdHistory[hIdx]; e.preventDefault(); }
  if (e.key === 'ArrowDown') { hIdx = Math.max(-1, hIdx - 1); e.target.value = cmdHistory[hIdx] || ''; e.preventDefault(); }
};

// ======================================================================
// Jugadores
// ======================================================================
const emptyRow = (cols, title, text) => `<tr class="empty"><td colspan="${cols}"><b>${esc(title)}</b>${esc(text || '')}</td></tr>`;

async function loadPlayers() {
  const tb = $('#playersTbl tbody');
  try {
    const list = await api('/players');
    await loadModSummary();
    $('#playersCount').textContent = list.length || '';
    tb.innerHTML = list.length ? list.map(p => `
      <tr>
        <td class="who"><b>${esc(p.DisplayName)}</b>${modBadges(p.SteamID)}</td>
        <td><code>${esc(p.SteamID)}</code></td>
        <td class="num">${p.Ping} ms</td>
        <td class="num">${fmtDur(p.ConnectedSeconds)}</td>
        <td class="num">${Math.round(p.Health || 0)}</td>
        <td>
          <button class="btn btn-sm btn-quiet btn-icon" data-locate="${esc(p.SteamID)}" title="${esc(t('map.locate'))}" aria-label="${esc(t('map.locate'))}">${ic('locate')}</button>
          ${can('watch.review') ? `<button class="btn btn-sm btn-quiet" data-hist="${esc(p.SteamID)}">${ic('note')}${esc(t('mod.file'))}</button>` : ''}
          ${can('inventory.view') ? `<button class="btn btn-sm btn-quiet" data-inv="${esc(p.SteamID)}" data-name="${esc(p.DisplayName)}">${ic('backpack')}${esc(t('inv.button'))}</button>` : ''}
          ${can('players.kick') ? `<button class="btn btn-sm" data-quick="kick" data-id="${esc(p.SteamID)}" data-name="${esc(p.DisplayName)}">${esc(t('pl.kick'))}</button>` : ''}
          ${can('players.ban') ? `<button class="btn btn-sm btn-danger-outline" data-quick="ban" data-id="${esc(p.SteamID)}" data-name="${esc(p.DisplayName)}">${esc(t('pl.ban'))}</button>` : ''}
          ${can('players.admin') || can('players.give') ? `<button class="btn btn-sm btn-quiet" data-fill="${esc(p.SteamID)}" data-name="${esc(p.DisplayName)}">${esc(t('pl.manageBtn'))}</button>` : ''}
        </td>
      </tr>`).join('')
      : emptyRow(6, t('pl.empty'), '');
  } catch (e) {
    $('#playersCount').textContent = '';
    tb.innerHTML = emptyRow(6, t('pl.listError'), e.message);
  }
  loadBans();
  loadTeams();
}
async function loadBans() {
  const tb = $('#bansTbl tbody');
  try {
    const list = await api('/bans');
    $('#bansCount').textContent = list.length || '';
    tb.innerHTML = list.length ? list.map(b => b.raw ? `<tr><td colspan="3"><code>${esc(b.raw)}</code></td></tr>` : `
      <tr><td class="who"><b>${esc(b.name || t('pl.noName'))}</b><span class="sub">${esc(b.steamid)}</span></td>
      <td class="text-2">${esc(b.reason)}</td>
      <td>${can('players.ban') ? `<button class="btn btn-sm" data-quick="unban" data-id="${esc(b.steamid)}" data-name="${esc(b.name)}">${esc(t('pl.unban'))}</button>` : ''}</td></tr>`).join('')
      : emptyRow(3, t('pl.noBans'), '');
  } catch (e) { $('#bansCount').textContent = ''; tb.innerHTML = emptyRow(3, t('common.unavailable'), e.message); }
}
$('#refreshPlayers').onclick = loadPlayers;
$('#refreshBans').onclick = loadBans;

async function playerAction(action, steamid, extra = {}) {
  const who = extra.name || steamid;
  const r = await act(() => api('/players/action', { body: { action, steamid, ...extra } }), t('pl.done.' + action, { who }));
  if (r && state.view === 'players') loadPlayers();
}
document.addEventListener('click', async (e) => {
  const fill = e.target.closest('[data-fill]');
  if (fill) { $('#paId').value = fill.dataset.fill; $('#paName').value = fill.dataset.name; $('#paReason').focus(); return; }
  const q = e.target.closest('[data-quick]');
  if (!q) return;
  const a = q.dataset.quick, name = q.dataset.name || q.dataset.id;
  if (a === 'unban') {
    if (await confirmDialog({ title: t('pl.unban'), body: esc(t('pl.unbanBody', { who: name })), confirm: t('pl.unban') })) playerAction(a, q.dataset.id, { name });
    return;
  }
  const reason = await promptDialog({
    title: t(a === 'ban' ? 'pl.banTitle' : 'pl.kickTitle', { who: name }),
    label: t('pl.reasonLabel'), placeholder: t(a === 'ban' ? 'pl.banPh' : 'pl.kickPh'),
    confirm: t(a === 'ban' ? 'pl.ban' : 'pl.kick'), danger: a === 'ban',
  });
  if (reason === null) return;
  playerAction(a, q.dataset.id, { reason, name: q.dataset.name || '' });
});
$$('[data-pa]').forEach(b => b.onclick = async () => {
  const a = b.dataset.pa, id = $('#paId').value.trim();
  if (!/^\d{17}$/.test(id)) { toast(t('err.bad_steamid'), true); $('#paId').focus(); return; }
  if (a === 'ban' && !await confirmDialog({ title: t('pl.banTitle', { who: $('#paName').value || id }), body: esc(t('pl.banBody')), confirm: t('pl.ban'), danger: true })) return;
  if (a === 'owner' && !await confirmDialog({ title: t('pl.owner'), body: esc(t('pl.ownerBody')), confirm: t('pl.owner') })) return;
  playerAction(a, id, { name: $('#paName').value, reason: $('#paReason').value, item: $('#paItem').value.trim(), amount: $('#paAmount').value });
});

// ======================================================================
// Plugins
// ======================================================================
function setPluginTab(tab) {
  $$('#pluginTabs .tab').forEach(x => x.setAttribute('aria-selected', String(x.dataset.ptab === tab)));
  $$('[data-ptab-panel]').forEach(p => p.hidden = p.dataset.ptabPanel !== tab);
  if (tab === 'browse' && !$('#umodResults').children.length) searchUmod(1);
}
$$('#pluginTabs .tab').forEach(x => x.onclick = () => setPluginTab(x.dataset.ptab));

async function loadPlugins() {
  const noFw = !['oxide', 'carbon'].includes(state.status.framework);
  $('#pluginsNoFw').hidden = !noFw;
  const tb = $('#pluginsTbl tbody');
  if (noFw) { tb.innerHTML = emptyRow(5, t('plg.noFwTitle'), t('plg.noFwText')); return; }
  try {
    state.plugins = await api('/plugins');
    const active = state.plugins.filter(p => p.enabled).length;
    $('#pluginCount').textContent = state.plugins.length ? `${active}/${state.plugins.length}` : '';
    tb.innerHTML = state.plugins.length ? state.plugins.map(p => {
      const u = state.updates[p.name];
      const n = esc(p.name);
      return `<tr>
        <td><b>${esc(p.title || p.name)}</b><span class="sub">${esc(p.description || p.name + '.cs')}</span></td>
        <td>${esc(p.version || '?')}${u?.update ? `<span class="ver-up">${esc(t('plg.available', { v: u.latest }))}</span>` : ''}</td>
        <td class="text-2">${esc(p.author || '')}</td>
        <td><span class="state ${p.enabled ? 'state--on' : ''}">${esc(t(p.enabled ? 'plg.active' : 'plg.disabled'))}</span></td>
        <td>${!can('plugins') ? '' : `
          ${u?.update ? `<button class="btn btn-sm btn-primary" data-pl="update" data-n="${n}">${esc(t('plg.update'))}</button>` : ''}
          ${p.hasConfig ? `<button class="btn btn-sm btn-quiet" data-pl="config" data-n="${n}">${esc(t('plg.configure'))}</button>` : ''}
          ${p.enabled ? `<button class="btn btn-sm btn-quiet" data-pl="reload" data-n="${n}">${esc(t('plg.reload'))}</button>` : ''}
          <button class="btn btn-sm" data-pl="${p.enabled ? 'disable' : 'enable'}" data-n="${n}">${esc(t(p.enabled ? 'plg.disable' : 'plg.enable'))}</button>
          <button class="btn btn-sm btn-quiet btn-icon" data-pl="delete" data-n="${n}" aria-label="${esc(t('common.delete'))} ${n}" title="${esc(t('common.delete'))}">${ic('trash')}</button>`}
        </td></tr>`;
    }).join('') : emptyRow(5, t('plg.emptyTitle'), t('plg.emptyText'));
    const nu = Object.values(state.updates).filter(u => u.update).length;
    $('#navUpdates').textContent = nu || '';
    $('#navUpdates').classList.toggle('nav-count--alert', nu > 0);
  } catch (e) { tb.innerHTML = emptyRow(5, t('common.loadError'), e.message); }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pl]'); if (!b) return;
  const n = b.dataset.n, a = b.dataset.pl;
  if (a === 'reload') return act(() => api(`/plugins/${n}/reload`, { body: {} }), t('plg.reloaded', { name: n }));
  if (a === 'enable' || a === 'disable') { await act(() => api(`/plugins/${n}/${a}`, { body: {} }), t(a === 'enable' ? 'plg.enabledMsg' : 'plg.disabledMsg', { name: n })); return loadPlugins(); }
  if (a === 'delete') {
    const r = await openDialog({
      title: t('plg.deleteTitle', { name: n }),
      body: `<p>${esc(t('plg.deleteBody'))}</p>
        <label class="switch"><input type="checkbox" id="dlgPurge"><span class="switch-ui"></span><span>${esc(t('plg.purge'))}</span></label>`,
      actions: [cancelAct(), { label: t('plg.deleteBtn'), cls: 'btn-danger', get: () => ({ purge: $('#dlgPurge').checked }) }],
    });
    if (!r) return;
    await act(() => api(`/plugins/${n}?purge=${r.purge ? 1 : 0}`, { method: 'DELETE' }), t('plg.deleted', { name: n }));
    return loadPlugins();
  }
  if (a === 'update' || a === 'install') {
    b.disabled = true; b.textContent = t('plg.installing');
    const ok = await act(() => api('/plugins/install', { body: { name: n, downloadUrl: b.dataset.url } }), t(a === 'update' ? 'plg.updated' : 'plg.installed', { name: n }));
    if (ok) {
      delete state.updates[n];
      if (a === 'install') b.outerHTML = `<span class="installed">${ic('check')}${esc(t('plg.installedTag'))}</span>`;
    } else { b.disabled = false; b.textContent = t(a === 'update' ? 'plg.update' : 'plg.install'); }
    return loadPlugins();
  }
  if (a === 'config') {
    const r = await act(() => api(`/plugins/${n}/config`)); if (!r || r === true) return;
    const text = await openDialog({
      title: t('plg.configTitle', { name: n }), wide: true,
      body: `<textarea id="cfgText" spellcheck="false">${esc(r.text)}</textarea><p class="small">${esc(t('plg.configNote', { name: n }))}</p>`,
      actions: [cancelAct(), {
        label: t('plg.configSave'), cls: 'btn-primary', get: () => $('#cfgText').value,
        validate: () => { try { JSON.parse($('#cfgText').value); } catch (err) { return t('err.bad_json', { error: err.message }); } },
      }],
    });
    if (text !== null) act(() => api(`/plugins/${n}/config`, { method: 'PUT', body: { text } }), t('plg.configSaved', { name: n }));
  }
});

$('#reloadAll').onclick = () => act(() => api('/plugins/*/reload', { body: {} }), t('plg.reloadedAll'));
$('#checkUpdates').onclick = async () => {
  const b = $('#checkUpdates'), label = b.querySelector('span');
  b.disabled = true; label.textContent = t('plg.checking');
  const r = await act(() => api('/plugins/updates'));
  b.disabled = false; label.textContent = t('plg.checkUpdates');
  if (!r || r === true) return;
  state.updates = Object.fromEntries(r.map(u => [u.name, u]));
  const n = r.filter(u => u.update).length;
  toast(n ? tn('plg.updatesFound', n) : t('plg.upToDate'));
  loadPlugins();
};

async function searchUmod(page = 1) {
  const box = $('#umodResults');
  box.innerHTML = `<li class="msg">${esc(t('plg.searching'))}</li>`;
  $('#umodPager').innerHTML = '';
  try {
    const r = await api(`/plugins/search?q=${encodeURIComponent($('#umodQ').value)}&page=${page}&sort=${$('#umodSort').value}`);
    const installed = new Set(state.plugins.map(p => p.name.toLowerCase()));
    box.innerHTML = r.results.map(p => `
      <li>
        <div>
          <h4>${esc(p.title)} <span>${esc(t('plg.byline', { v: p.version, author: p.author }))}</span></h4>
          <p>${esc(p.description)}</p>
        </div>
        <div class="side">
          ${installed.has(p.name.toLowerCase()) ? `<span class="installed">${ic('check')}${esc(t('plg.installedTag'))}</span>`
            : !can('plugins') ? '' : `<button class="btn btn-sm btn-primary" data-pl="install" data-n="${esc(p.name)}" data-url="${esc(p.downloadUrl)}">${esc(t('plg.install'))}</button>`}
          <span class="dl">${esc(t('plg.downloads', { n: typeof p.downloads === 'number' ? fmtNum(p.downloads) : p.downloads }))}</span>
          <a class="ext" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(t('plg.viewUmod'))} ${ic('external')}</a>
        </div>
      </li>`).join('') || `<li class="msg">${esc(t('plg.noResults'))}</li>`;
    if (r.lastPage > 1) {
      $('#umodPager').innerHTML = `
        <button class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} data-upage="${page - 1}">${esc(t('common.prev'))}</button>
        <span>${esc(t('common.page', { p: r.page, n: r.lastPage }))}</span>
        <button class="btn btn-sm" ${page >= r.lastPage ? 'disabled' : ''} data-upage="${page + 1}">${esc(t('common.next'))}</button>`;
    }
  } catch (e) { box.innerHTML = `<li class="msg">${esc(t('plg.umodError', { error: e.message }))}</li>`; }
}
$('#umodForm').onsubmit = (e) => { e.preventDefault(); searchUmod(1); };
$('#umodSort').onchange = () => searchUmod(1);
document.addEventListener('click', (e) => { const p = e.target.closest('[data-upage]'); if (p) searchUmod(+p.dataset.upage); });

async function uploadFiles(files) {
  for (const f of files) {
    if (!f.name.endsWith('.cs')) { toast(t('plg.notCs', { name: f.name }), true); continue; }
    const source = await f.text();
    await act(() => api('/plugins/upload', { body: { filename: f.name, source } }), t('plg.uploaded', { name: f.name }));
  }
  $('#pluginFile').value = '';
  await loadPlugins();
  setPluginTab('installed');
}
const drop = $('#drop');
$('#pluginFile').onchange = (e) => uploadFiles(e.target.files);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); };

// ======================================================================
// Permisos
// ======================================================================
$$('[data-pm]').forEach(b => b.onclick = async () => {
  const a = b.dataset.pm;
  let body;
  if (a === 'grant' || a === 'revoke') body = { action: a, type: $('#pmType').value, target: $('#pmTarget').value.trim(), perm: $('#pmPerm').value.trim() };
  else if (a === 'addgroup' || a === 'removegroup') body = { action: a, target: $('#pgName').value.trim() };
  else body = { action: a, target: $('#pgUser').value.trim(), perm: $('#pgName').value.trim() };
  const r = await act(() => api('/perms', { body }), t('perm.done.' + a));
  if (r?.output) $('#permsOut').textContent = r.output;
});
$('#psBtn').onclick = async () => {
  const r = await act(() => api('/perms', { body: { action: 'show', type: $('#psType').value, target: $('#psTarget').value.trim() } }));
  if (r) $('#permsOut').textContent = r.output || t('perm.noResults');
};

// ======================================================================
// Ajustes del servidor y programador
// ======================================================================
async function loadConfig() {
  state.config = await api('/config');
  const f = $('#cfgForm'), s = state.config.server;
  for (const el of f.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name]; else el.value = s[el.name];
  }
  renderSchedule();
  renderStatus();
}
$('#randSeed').onclick = () => { $('#cfgForm').elements.seed.value = Math.floor(Math.random() * 2147483647); };
$('#cfgForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  const r = await act(() => api('/config/server', { method: 'PUT', body }), t('cfg.saved'));
  if (r && r !== true) { state.config.server = r; renderStatus(); }
};

function renderSchedule() {
  const sc = state.config.schedule, f = $('#schedForm');
  for (const k of ['restartWarningMinutes', 'keepBackups']) f.elements[k].value = sc[k];
  for (const k of ['autoBackupOnRestart', 'autoUpdateOnRestart']) f.elements[k].checked = sc[k];
  $('#restartList').innerHTML = sc.restarts.length
    ? sc.restarts.map((x, i) => `<span class="time">${esc(x)}<button type="button" data-rmrestart="${i}" aria-label="${esc(t('common.remove'))} ${esc(x)}">${ic('x')}</button></span>`).join('')
    : `<span class="none">${esc(t('sch.none'))}</span>`;
  $('#annList').innerHTML = sc.announcements.map((a, i) => `
    <div class="ann">
      <input data-ann-msg="${i}" value="${esc(a.message)}" placeholder="${esc(t('sch.annPh'))}" aria-label="${esc(t('sch.annMsg'))}">
      <label class="every"><input data-ann-int="${i}" type="number" min="1" value="${a.intervalMinutes}" aria-label="${esc(t('sch.annEvery'))}"><span>min</span></label>
      <button type="button" class="btn btn-quiet btn-icon" data-rmann="${i}" aria-label="${esc(t('common.remove'))}">${ic('trash')}</button>
    </div>`).join('') || `<p class="text-2">${esc(t('sch.noAnn'))}</p>`;
  const next = state.status.nextRestart;
  $('#schedNext').textContent = next ? t('sch.next', { d: fmtDate(next) }) : '';
}
function readAnnouncements() {
  return state.config.schedule.announcements.map((_, i) => ({ message: $(`[data-ann-msg="${i}"]`).value, intervalMinutes: +$(`[data-ann-int="${i}"]`).value }));
}
$('#addRestart').onclick = () => {
  const v = $('#newRestart').value; if (!v) { $('#newRestart').focus(); return; }
  const sc = state.config.schedule;
  if (!sc.restarts.includes(v)) sc.restarts.push(v);
  sc.restarts.sort(); renderSchedule();
};
$('#addAnn').onclick = () => { state.config.schedule.announcements = readAnnouncements(); state.config.schedule.announcements.push({ message: '', intervalMinutes: 30 }); renderSchedule(); $(`[data-ann-msg="${state.config.schedule.announcements.length - 1}"]`).focus(); };
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-rmrestart]');
  if (r) { state.config.schedule.restarts.splice(+r.dataset.rmrestart, 1); renderSchedule(); }
  const a = e.target.closest('[data-rmann]');
  if (a) { state.config.schedule.announcements = readAnnouncements(); state.config.schedule.announcements.splice(+a.dataset.rmann, 1); renderSchedule(); }
});
$('#schedForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    restarts: state.config.schedule.restarts, announcements: readAnnouncements(),
    restartWarningMinutes: f.restartWarningMinutes.value, keepBackups: f.keepBackups.value,
    autoBackupOnRestart: f.autoBackupOnRestart.checked, autoUpdateOnRestart: f.autoUpdateOnRestart.checked,
  };
  const r = await act(() => api('/config/schedule', { method: 'PUT', body }), t('sch.saved'));
  if (r && r !== true) { state.config.schedule = r; await refreshStatus(); renderSchedule(); }
};

// ======================================================================
// Copias y wipe
// ======================================================================
async function loadBackups() {
  const tb = $('#backupsTbl tbody');
  try {
    const list = await api('/backups');
    $('#backupsCount').textContent = list.length || '';
    tb.innerHTML = list.length ? list.map(b => {
      const kind = /pre-bpwipe/.test(b.name) ? 'bk.kFull' : /pre-wipe/.test(b.name) ? 'bk.kWipe' : /_auto/.test(b.name) ? 'bk.kAuto' : 'bk.kManual';
      const n = esc(b.name), en = encodeURIComponent(b.name);
      return `<tr><td><b>${esc(t(kind))}</b><span class="sub">${n}</span></td><td class="num">${fmtSize(b.size)}</td><td class="text-2 nowrap">${fmtDate(b.created)}</td>
      <td>${!can('backups') ? '' : `<a class="btn btn-sm btn-quiet btn-icon" href="/api/backups/${en}/download" title="${esc(t('common.download'))}" aria-label="${esc(t('common.download'))}">${ic('download')}</a>`}
      ${can('backups') ? `<button class="btn btn-sm" data-bk="restore" data-n="${n}">${esc(t('bk.restore'))}</button>
      <button class="btn btn-sm btn-quiet btn-icon" data-bk="delete" data-n="${n}" title="${esc(t('common.delete'))}" aria-label="${esc(t('common.delete'))}">${ic('trash')}</button>` : ''}</td></tr>`;
    }).join('') : emptyRow(4, t('bk.emptyTitle'), t('bk.emptyText'));
  } catch (e) { tb.innerHTML = emptyRow(4, t('common.loadError'), e.message); }
}
$('#mkBackup').onclick = async () => {
  const b = $('#mkBackup'); b.disabled = true;
  await act(() => api('/backups', { body: {} }), t('bk.created'));
  b.disabled = false; loadBackups();
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bk]'); if (!b) return;
  const n = b.dataset.n;
  if (b.dataset.bk === 'delete' && await confirmDialog({ title: t('bk.deleteTitle'), body: t('bk.deleteBody', { name: `<code>${esc(n)}</code>` }), confirm: t('bk.deleteTitle'), danger: true })) {
    await act(() => api(`/backups/${encodeURIComponent(n)}`, { method: 'DELETE' }), t('bk.deleted')); loadBackups();
  }
  if (b.dataset.bk === 'restore' && await confirmDialog({ title: t('bk.restoreTitle'), body: esc(t('bk.restoreBody')), confirm: t('bk.restore'), danger: true })) {
    await act(() => api(`/backups/${encodeURIComponent(n)}/restore`, { body: {} }), t('bk.restored'));
  }
});
$('#wipeBtn').onclick = async () => {
  const bp = $('#wBp').checked;
  const ok = await confirmDialog({
    title: t(bp ? 'bk.wipeFullTitle' : 'bk.wipeMapTitle'), body: esc(t(bp ? 'bk.wipeFullBody' : 'bk.wipeMapBody')),
    confirm: t(bp ? 'bk.wipeFullTitle' : 'bk.wipe'), danger: true,
  });
  if (!ok) return;
  const r = await act(() => api('/wipe', { body: { blueprints: bp, newSeed: $('#wSeed').checked, backup: $('#wBackup').checked } }));
  if (r && r !== true) { toast(t('bk.wiped', { n: r.removed.length, seed: r.seed })); loadBackups(); if (state.config) state.config.server.seed = r.seed; }
};

// ======================================================================
// Instalación
// ======================================================================
function firewallCommands(platform, s) {
  const port = location.port || 80;
  if (platform === 'windows') {
    return [
      t('ins.fwWinComment'),
      `New-NetFirewallRule -DisplayName "Rust game" -Direction Inbound -Protocol UDP -LocalPort ${s.port} -Action Allow`,
      `New-NetFirewallRule -DisplayName "Rust query" -Direction Inbound -Protocol UDP -LocalPort ${s.queryPort} -Action Allow`,
      `New-NetFirewallRule -DisplayName "Rust+ app" -Direction Inbound -Protocol TCP -LocalPort ${s.appPort} -Action Allow`,
      `New-NetFirewallRule -DisplayName "Scrapwarden" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`,
      '',
      t('ins.fwRouter'),
    ].join('\n');
  }
  return [t('ins.fwLinuxComment'), `sudo ufw allow ${s.port}/udp`, `sudo ufw allow ${s.queryPort}/udp`, `sudo ufw allow ${s.appPort}/tcp`, `sudo ufw allow ${port}/tcp`].join('\n');
}

function renderInstallState() {
  const s = state.status;
  const busy = !!s.installer?.busy;
  const running = s.status !== 'stopped';
  const plat = s.platform, host = s.hostPlatform;

  const mayInstall = can('install');
  $$('input[name=plat]').forEach(r => { r.checked = r.value === plat; r.disabled = busy || running || !mayInstall; });
  $('#platHint').textContent = t('ins.hostIs', { os: osName(host) }) + (s.platformSetting === 'auto' ? ' ' + t('ins.auto') : '');
  const mismatch = plat && host && plat !== host;
  $('#platWarn').hidden = !mismatch;
  if (mismatch) $('#platWarnText').innerHTML = t('ins.mismatch', { files: osName(plat), host: osName(host) });

  $('#instServer').textContent = s.installed ? t('ins.installedFor', { os: osName(plat) }) : t('ins.notInstalled');
  $('#instServer').classList.toggle('ok', !!s.installed);
  $('#stepServer').classList.toggle('is-done', !!s.installed);
  $('#instFw').textContent = s.framework === 'none' ? t('ins.noFw') : t('ins.fwInstalled', { fw: FW_LABEL[s.framework] });
  $('#instFw').classList.toggle('ok', s.framework !== 'none');
  $('#stepFw').classList.toggle('is-done', s.framework !== 'none');
  $('#stepStart').classList.toggle('is-done', s.status === 'running');
  $('#instServerBtn').disabled = busy || running || !mayInstall;
  $('#instValidate').disabled = !mayInstall;
  $('#instServerBtn').textContent = t(s.installed ? 'ins.update' : 'ins.install');
  $$('[data-fw]').forEach(b => b.disabled = busy || running || !s.installed || b.dataset.fw === s.framework || !mayInstall);
  $('#instBusy').textContent = busy ? t('task.' + s.installer.busy) : t('ins.idle');
  $('#instBusy').className = 'tag' + (busy ? ' tag--busy' : '');

  if (state.config) {
    const c = state.config.server;
    $('#fwTitle').textContent = t('ins.fwTitle', { os: osName(plat) });
    $('#fwCmds').textContent = firewallCommands(plat, c);
    $('#portsInfo').innerHTML = [[t('ins.pGame'), `${c.port} UDP`], [t('ins.pQuery'), `${c.queryPort} UDP`], ['Rust+', `${c.appPort} TCP`]]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  }
}
async function loadInstall() {
  if (!state.config) state.config = await api('/config');
  if (!state.insMode) state.insMode = state.status.mode === 'remote' ? 'remote' : 'new';
  renderInsMode();
  renderInstallState();
  renderProgress();
  const logs = state.consoleLines.filter(e => e.source === 'installer').slice(-300);
  $('#instLog').innerHTML = logs.length ? logs.map(lineHtml).join('') : `<div class="ln src-panel">${esc(t('ins.logEmpty'))}</div>`;
  $('#instLog').scrollTop = 1e9;
}
$$('input[name=plat]').forEach(r => r.onchange = async () => {
  const res = await act(() => api('/platform', { method: 'PUT', body: { platform: r.value } }), t('ins.platformSet', { os: osName(r.value) }));
  if (res) await refreshStatus();
  renderInstallState();
});
$('#copyFw').onclick = async () => {
  try { await navigator.clipboard.writeText($('#fwCmds').textContent); toast(t('ins.copied')); } catch { toast(t('common.copyFailed'), true); }
};
$('#instServerBtn').onclick = async () => {
  if (await act(() => api('/install/server', { body: { validate: $('#instValidate').checked } }), t('ins.started'))) refreshStatus();
};
$$('[data-fw]').forEach(b => b.onclick = async () => {
  const fw = b.dataset.fw;
  if (fw === 'none' && !await confirmDialog({ title: t('ins.vanilla'), body: esc(t('ins.vanillaBody')), confirm: t('ins.vanilla') })) return;
  if (fw !== 'none' && state.status.framework !== 'none' && !await confirmDialog({ title: t('ins.switchTitle', { fw: FW_LABEL[fw] }), body: esc(t('ins.switchBody', { cur: FW_LABEL[state.status.framework], fw: FW_LABEL[fw] })), confirm: t('ins.switchConfirm', { fw: FW_LABEL[fw] }) })) return;
  if (await act(() => api('/install/framework', { body: { framework: fw } }), t('ins.started'))) refreshStatus();
});

// ======================================================================
// Cuenta
// ======================================================================
async function loadAccount() {
  renderTfa();
  loadUpdate();
  const sel = $('#notifyLang');
  sel.innerHTML = LANGS.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  try { const p = await api('/panel'); sel.value = p.notifyLang; state.itemIcons = p.itemIcons; $('#iconUrl').value = p.itemIcons; } catch {}
}
const ICONS_DEFAULT = 'https://files.facepunch.com/rust/item/{shortname}_512.png';
const ICONS_FALLBACK = 'https://rustlabs.com/img/items180/{shortname}.png'; // segunda fuente si la primera no tiene el icono
const iconFrom = (tpl, shortname) => tpl && /^[\w.-]+$/.test(shortname || '') ? tpl.replace('{shortname}', encodeURIComponent(shortname)) : '';
const iconUrl = (shortname) => iconFrom(state.itemIcons, shortname);
const iconAlt = (shortname) => state.itemIcons && state.itemIcons !== ICONS_FALLBACK ? iconFrom(ICONS_FALLBACK, shortname) : '';
async function saveIcons(url) {
  const r = await act(() => api('/panel/icons', { method: 'PUT', body: { itemIcons: url } }), t('acc.iconsSaved'));
  if (r) { state.itemIcons = r.itemIcons; $('#iconUrl').value = r.itemIcons; }
}
$('#iconForm').onsubmit = (e) => { e.preventDefault(); saveIcons($('#iconUrl').value.trim()); };
$('#iconReset').onclick = () => saveIcons(ICONS_DEFAULT);
$('#notifyLang').onchange = (e) => act(() => api('/panel', { method: 'PUT', body: { notifyLang: e.target.value } }), t('acc.notifySaved'));
$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (await act(() => api('/password', { body: { current: f.current.value, password: f.password.value } }), t('acc.changed'))) e.target.reset();
};

// ======================================================================
// Vigilancia
// ======================================================================
let invHistId = null;
const alertTitle = (a) => a.code ? t(`alert.${a.code}.title`, a.params || {}) : (a.title || '');
const alertDetail = (a) => a.code ? t(`alert.${a.code}.detail`, a.params || {}) : (a.detail || '');

function setAlertBadge(n) {
  state.unreadAlerts = Math.max(0, n || 0);
  $('#navAlerts').textContent = state.unreadAlerts || '';
}
function onAlert(a) {
  setAlertBadge(state.unreadAlerts + 1);
  if (a.severity === 'high') toast(t('watch.highToast', { title: alertTitle(a), name: a.name || '—' }), true);
  if (state.view === 'watch') { loadAlerts(); loadSuspects(); }
}
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.agoM', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.agoH', { n: Math.floor(s / 3600) });
  return fmtDate(ts);
}

async function loadWatch() {
  try {
    const w = await api('/watch');
    state.watch = w;
    setAlertBadge(w.unread);
    const cb = $('#bridgeCallout');
    let msg = '', canInstall = false, info = false;
    if (!['oxide', 'carbon'].includes(w.framework)) msg = t('watch.basic');
    else if (!w.installed) { msg = t('watch.missing'); canInstall = true; }
    else if (!w.loaded) { msg = t(state.status.rcon ? 'watch.notResponding' : 'watch.waiting'); info = true; }
    cb.hidden = !msg;
    cb.classList.toggle('callout--info', info);
    $('#bridgeText').innerHTML = msg;
    $('#bridgeInstall').hidden = !canInstall;
    const f = $('#watchForm'), st = w.settings;
    for (const el of f.elements) {
      if (!el.name || !(el.name in st)) continue;
      if (el.type === 'checkbox') el.checked = !!st[el.name];
      else el.value = el.name === 'headshotRatio' ? Math.round(st[el.name] * 100) : st[el.name];
    }
  } catch (e) { toast(e.message, true); }
  loadAlerts(); loadSuspects(); loadSteamSettings();
}

async function loadAlerts() {
  const f = state.alertFilter;
  const q = f === 'high' ? 'status=all&severity=high' : f === 'new' ? 'status=new' : 'status=all';
  const box = $('#alertsList');
  try {
    const list = await api('/watch/alerts?' + q);
    $('#alertsCount').textContent = list.length || '';
    box.innerHTML = list.length ? list.map(a => {
      const sid = esc(a.steamid || ''), nm = esc(a.name || '');
      return `
      <li class="alert ${a.status !== 'new' ? 'is-done' : ''}" data-sev="${a.severity}">
        <div class="alert-top">
          <span class="sev sev--${a.severity}">${esc(t('sev.' + a.severity))}</span>
          <span class="alert-title">${esc(alertTitle(a))}</span>
          <span class="alert-time" title="${esc(fmtDate(a.t))}">${esc(timeAgo(a.t))}</span>
        </div>
        <div class="alert-who">${a.steamid ? `${nm || esc(t('pl.player'))}<code>${sid}</code>` : esc(t('kind.' + a.kind))}</div>
        <p class="alert-detail">${esc(alertDetail(a))}</p>
        <div class="alert-actions">
          ${a.steamid ? `
            ${can('inventory.view') ? `<button class="btn btn-sm" data-inv="${sid}" data-name="${nm}">${ic('backpack')}${esc(t('inv.button'))}</button>` : ''}
            ${can('watch.review') ? `<button class="btn btn-sm btn-quiet" data-hist="${sid}">${ic('eye')}${esc(t('watch.history'))}</button>` : ''}
            <button class="btn btn-sm btn-quiet btn-icon" data-locate="${sid}" title="${esc(t('map.locate'))}" aria-label="${esc(t('map.locate'))}">${ic('locate')}</button>
            ${can('players.kick') ? `<button class="btn btn-sm btn-quiet" data-quick="kick" data-id="${sid}" data-name="${nm}">${esc(t('pl.kick'))}</button>` : ''}
            ${can('players.ban') ? `<button class="btn btn-sm btn-danger-outline" data-quick="ban" data-id="${sid}" data-name="${nm}">${esc(t('pl.ban'))}</button>` : ''}` : ''}
          <span style="flex:1"></span>
          ${!can('watch.review') ? '' : a.status === 'new'
            ? `<button class="btn btn-sm btn-quiet" data-alert="${a.id}" data-to="dismissed">${esc(t('watch.dismiss'))}</button><button class="btn btn-sm" data-alert="${a.id}" data-to="reviewed">${ic('check')}${esc(t('watch.reviewed'))}</button>`
            : `<button class="btn btn-sm btn-quiet" data-alert="${a.id}" data-to="new">${esc(t('watch.reopen'))}</button>`}
        </div>
      </li>`;
    }).join('')
      : `<li class="msg"><b>${esc(t(f === 'new' ? 'watch.emptyNew' : 'watch.emptyAll'))}</b>${esc(t('watch.emptyText'))}</li>`;
  } catch (e) { box.innerHTML = `<li class="msg"><b>${esc(t('common.loadError'))}</b>${esc(e.message)}</li>`; }
}

async function loadSuspects() {
  const tb = $('#suspectsTbl tbody');
  try {
    const list = await api('/watch/suspects');
    const th = state.watch?.settings || {};
    tb.innerHTML = list.length ? list.map(p => {
      const hsCls = p.headshotPct === null ? '' : p.headshotPct >= th.headshotRatio * 100 ? 'hot' : p.headshotPct >= th.headshotRatio * 75 ? 'warm' : '';
      const sid = esc(p.steamid);
      return `<tr>
        <td class="who"><b>${esc(p.name)}</b>${p.banned ? ` <span class="sev sev--high">${esc(t('watch.bannedTag'))}</span>` : ''}<span class="sub">${sid}</span></td>
        <td class="num ${hsCls}" title="${esc(t('watch.hitsTip', { n: p.hits }))}">${p.headshotPct === null ? '—' : p.headshotPct + ' %'}</td>
        <td class="num">${p.longest ? p.longest + ' m' : '—'}</td>
        <td class="num ${p.violations10m >= (th.violationsBurst || 5) ? 'hot' : ''}">${p.violations10m || '—'}</td>
        <td class="num">${p.reports || '—'}</td>
        <td>${can('watch.review') ? `<button class="btn btn-sm btn-quiet btn-icon" data-hist="${sid}" aria-label="${esc(t('watch.history'))}" title="${esc(t('watch.history'))}">${ic('eye')}</button>` : ''}${can('inventory.view') ? `<button class="btn btn-sm btn-quiet btn-icon" data-inv="${sid}" data-name="${esc(p.name)}" aria-label="${esc(t('inv.button'))}" title="${esc(t('inv.button'))}">${ic('backpack')}</button>` : ''}</td>
      </tr>`;
    }).join('') : emptyRow(6, t('watch.noSuspects'), t('watch.noSuspectsText'));
  } catch (e) { tb.innerHTML = emptyRow(6, t('common.unavailable'), e.message); }
}

$$('input[name=afilter]').forEach(r => r.onchange = () => { state.alertFilter = r.value; loadAlerts(); });
$('#suspectsRefresh').onclick = loadSuspects;
$('#alertsReadAll').onclick = async () => { if (await act(() => api('/watch/alerts-read', { body: {} }), t('watch.allRead'))) { setAlertBadge(0); loadAlerts(); } };
$('#bridgeInstall').onclick = async () => { if (isRemoteMode()) return bridgeManualDialog(); if (await act(() => api('/watch/bridge', { body: {} }), t('watch.bridgeInstalled'))) setTimeout(loadWatch, 6000); };
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-alert]'); if (!b) return;
  const r = await act(() => api('/watch/alerts/' + b.dataset.alert, { body: { status: b.dataset.to } }));
  if (r) { const w = await api('/watch').catch(() => null); if (w) setAlertBadge(w.unread); loadAlerts(); loadSuspects(); }
});
$('#watchForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  body.headshotRatio = Number(body.headshotRatio) / 100;
  const r = await act(() => api('/watch/settings', { method: 'PUT', body }), t('watch.saved'));
  if (r && r !== true && state.watch) state.watch.settings = r;
};
$('#testDiscord').onclick = () => act(() => api('/watch/test-discord', { body: { webhook: $('#watchForm').elements.discordWebhook.value } }), t('watch.testSent'));

// Historial de un jugador
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-hist]'); if (!b) return;
  const p = await act(() => api('/watch/player/' + b.dataset.hist)); if (!p || p === true) return;
  invHistId = b.dataset.hist;
  if (!p.steam) p.steam = null;
  const x = p.totals || {};
  const row = (k, v) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`;
  openDialog({
    title: p.names?.at(-1) || p.steamid, wide: true,
    body: `
      <dl class="facts facts--inline">
        ${row('hist.steamid', `<a class="link" href="https://steamcommunity.com/profiles/${esc(p.steamid)}" target="_blank" rel="noopener">${esc(p.steamid)}</a>`)}
        ${row('hist.names', esc((p.names || []).join(', ') || '—'))}
        ${row('hist.ips', esc((p.ips || []).join(', ') || '—'))}
        ${row('hist.first', p.firstSeen ? esc(fmtDate(p.firstSeen)) : '—')}
        ${row('hist.last', p.lastSeen ? esc(fmtDate(p.lastSeen)) : '—')}
        ${row('hist.state', esc(t(p.banned ? 'hist.banned' : 'hist.notBanned')))}
        ${row('hist.hits', esc(t('hist.hitsVal', { n: x.hits || 0, pct: x.hits ? Math.round(x.headshots / x.hits * 100) : 0 })))}
        ${row('hist.kills', fmtNum(x.kills))}
        ${row('hist.longest', x.longest ? Math.round(x.longest) + ' m' : '—')}
        ${row('hist.violations', fmtNum(x.violations))}
        ${row('hist.reports', fmtNum(x.reports))}
      </dl>
      <div class="steam-box" id="steamBox">${steamBlock(p.steam)}</div>
      ${can('players.moderate') ? `<div class="mod-box" id="modBox" data-sid="${esc(p.steamid)}" data-name="${esc(p.names?.at(-1) || '')}"><p class="small">${esc(t('common.loading'))}</p></div>` : ''}
      <h4 style="margin:8px 0 0;color:var(--text)">${esc(t('watch.alerts'))}</h4>
      <ul class="alerts" style="border:1px solid var(--line-soft);border-radius:6px">${(p.alerts || []).map(a => `
        <li class="alert ${a.status !== 'new' ? 'is-done' : ''}" data-sev="${a.severity}"><div class="alert-top"><span class="sev sev--${a.severity}">${esc(t('sev.' + a.severity))}</span><span class="alert-title">${esc(alertTitle(a))}</span><span class="alert-time">${esc(fmtDate(a.t))}</span></div><p class="alert-detail">${esc(alertDetail(a))}</p></li>`).join('') || `<li class="msg">${esc(t('hist.noAlerts'))}</li>`}</ul>`,
    actions: [{ label: t('common.close'), cls: 'btn-quiet', value: null }],
  });
  if (can('players.moderate')) loadModBox();
});

function steamBlock(sp) {
  const btn = can('watch.review') ? `<button class="btn btn-sm" data-steamcheck="${esc(sp?.steamid || '')}">${ic('steam')}${esc(t(sp ? 'steam.recheck' : 'steam.check'))}</button>` : '';
  if (!sp) return `<div class="steam-head"><b>Steam</b>${btn}</div><p class="small">${esc(t('steam.notChecked'))}</p>`;
  const age = sp.created ? Math.floor((Date.now() - sp.created) / 86400000) : null;
  const flag = (bad, text) => `<span class="sflag ${bad ? 'bad' : ''}">${esc(text)}</span>`;
  return `<div class="steam-head"><b>Steam</b><a class="link small" href="${esc(sp.url)}" target="_blank" rel="noopener">${esc(sp.name || sp.steamid)}</a>${btn}</div>
    <div class="sflags">
      ${flag(sp.vacBans || sp.gameBans, sp.vacBans || sp.gameBans ? t('steam.fBans', { vac: sp.vacBans, game: sp.gameBans, days: sp.daysSinceBan }) : t('steam.fNoBans'))}
      ${sp.communityBanned ? flag(true, t('steam.fCommunity')) : ''}
      ${flag(age !== null && age < (state.steamSettings?.newDays || 30), age === null ? t('steam.fAgeUnknown') : t('steam.fAge', { days: age }))}
      ${flag(!sp.public, t(sp.public ? 'steam.fPublic' : 'steam.fPrivate'))}
      ${sp.rustHours !== null ? flag(sp.rustHours < (state.steamSettings?.minHours || 10), t('steam.fHours', { h: sp.rustHours })) : ''}
    </div>
    <p class="small">${esc(t('steam.checkedAt', { d: fmtDate(sp.checkedAt) }))}</p>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-steamcheck]'); if (!b) return;
  const id = b.dataset.steamcheck || $('#dialogBody [data-steamcheck]')?.closest('.dialog')?.dataset.sid;
  b.disabled = true;
  const r = await act(() => api('/steam/check/' + (id || invHistId), { body: {} }));
  b.disabled = false;
  if (r && r !== true) { $('#steamBox').innerHTML = steamBlock(r.profile); toast(r.findings.length ? t('steam.findings', { n: r.findings.length }) : t('steam.clean')); }
});

// ======================================================================
// Inventario
// ======================================================================
const INV_GROUPS = [['main', 'inv.main'], ['wear', 'inv.wear'], ['belt', 'inv.belt']];
let invState = null;

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-inv]'); if (!b) return;
  openInventory(b.dataset.inv, b.dataset.name);
});

function openInventory(steamid, name) {
  invState = { steamid, name, data: null, sel: null };
  openDialog({
    title: t('inv.title', { name: name || steamid }), wide: true,
    body: `<div id="invBody"><p class="inv-note">${esc(t('inv.loading'))}</p></div>`,
    actions: [{ label: t('common.close'), cls: 'btn-quiet', value: null }],
  }).then(() => { invState = null; });
  loadInventory();
}

async function loadInventory() {
  if (!invState) return;
  const box = $('#invBody');
  try {
    const d = await api(`/players/${invState.steamid}/inventory`);
    if (!invState) return;
    invState.data = d; invState.sel = null;
    const where = t(d.dead ? 'inv.dead' : d.online ? (d.sleeping ? 'inv.sleeping' : 'inv.online') : 'inv.offline');
    const total = ['wear', 'belt', 'main'].reduce((n, k) => n + d[k].items.length, 0);
    box.innerHTML = `
      <div class="inv-head">
        <dl class="facts"><dt>${esc(t('inv.state'))}</dt><dd>${esc(where)}</dd><dt>${esc(t('pl.health'))}</dt><dd>${d.health}</dd><dt>${esc(t('inv.position'))}</dt><dd>${esc(d.position)}</dd><dt>${esc(t('inv.items'))}</dt><dd>${total}</dd></dl>
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-quiet" id="invRefresh">${ic('refresh')}${esc(t('common.refresh'))}</button>
      </div>
      <div class="inv-grid">${INV_GROUPS.map(([k, label]) => {
        const c = d[k], bySlot = Object.fromEntries(c.items.map(i => [i.slot, i]));
        const cells = Array.from({ length: c.capacity }, (_, slot) => {
          const it = bySlot[slot];
          if (!it) return '<div class="slot slot--empty" aria-hidden="true"></div>';
          const cond = it.condition >= 0 ? `<span class="slot-cond ${it.condition < .25 ? 'low' : it.condition < .5 ? 'mid' : ''}" style="width:${Math.round(it.condition * 100)}%"></span>` : '';
          const src = iconUrl(it.shortname);
          return `<button class="slot ${src ? 'has-img' : ''}" data-slot="${k}:${slot}" aria-pressed="false" title="${esc(it.name)}" aria-label="${esc(it.name)}">
            ${src ? `<img class="slot-img" src="${esc(src)}" data-alt="${esc(iconAlt(it.shortname))}" alt="" loading="lazy" decoding="async">` : ''}<span class="slot-name">${esc(it.name)}</span>${it.skin && it.skin !== '0' ? `<span class="slot-skin" title="${esc(t('inv.skinned'))}"></span>` : ''}
            ${it.amount > 1 ? `<span class="slot-amt">×${fmtNum(it.amount)}</span>` : ''}${cond}</button>`;
        }).join('');
        return `<div class="inv-group inv-group--${k}"><h4>${esc(t(label))}<span>${c.items.length}/${c.capacity}</span></h4><div class="slots ${k === 'wear' ? 'slots--wear' : ''}">${cells}</div></div>`;
      }).join('')}</div>
      <div class="inv-detail" id="invDetail"><span class="grow">${esc(t('inv.select'))}</span>${can('inventory.edit') ? `<button class="btn btn-sm btn-danger-outline" id="invClear">${ic('trash')}<span>${esc(t('inv.clear'))}</span></button>` : ''}</div>
      <p class="inv-note">${esc(t('inv.note'))}</p>`;
    $('#invRefresh').onclick = loadInventory;
    if ($('#invClear')) $('#invClear').onclick = clearInventory;
    $$('#invBody .slot[data-slot]').forEach(el => el.onclick = () => selectSlot(el));
    // Si una imagen no existe en el servidor de iconos, se vuelve a mostrar el nombre
    $$('#invBody .slot-img').forEach(img => { img.onerror = () => {
      if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ''; return; } // prueba la segunda fuente
      img.closest('.slot')?.classList.remove('has-img'); img.remove();
    }; });
  } catch (e) {
    if (!invState) return;
    const missing = /ScrapwardenBridge/.test(e.message);
    box.innerHTML = `<div class="callout"><svg class="i"><use href="#i-alert"/></svg><div class="callout-body">${esc(e.message)}${missing ? ` <button class="link" data-goto="watch">${esc(t('inv.goWatch'))}</button>` : ''}</div></div>`;
  }
}

function selectSlot(el) {
  $$('#invBody .slot[aria-pressed="true"]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  el.setAttribute('aria-pressed', 'true');
  const [k, slot] = el.dataset.slot.split(':');
  const it = invState.data[k].items.find(i => i.slot === +slot);
  invState.sel = { k, slot: +slot, it };
  const bits = [`<b>${esc(it.name)}</b>`, `<code>${esc(it.shortname)}</code>`, esc(t('inv.amount', { n: it.amount }))];
  if (it.condition >= 0) bits.push(esc(t('inv.condition', { n: Math.round(it.condition * 100) })));
  if (it.ammo >= 0) bits.push(esc(t('inv.ammo', { n: it.ammo })));
  if (it.mods?.length) bits.push(esc(t('inv.mods', { list: it.mods.join(', ') })));
  if (it.skin && it.skin !== '0') bits.push(esc(t('inv.skin', { id: String(it.skin) })));
  const big = el.querySelector('.slot-img')?.currentSrc || el.querySelector('.slot-img')?.src || '';
  $('#invDetail').innerHTML = `${big ? `<img class="inv-detail-img" src="${esc(big)}" alt="">` : ''}<span class="grow">${bits.join('<span style="color:var(--line)"> | </span>')}</span>
    ${can('inventory.edit') ? `<button class="btn btn-sm btn-danger-outline" id="invRemove">${ic('trash')}${esc(t('inv.remove'))}</button>` : ''}`;
  if ($('#invRemove')) $('#invRemove').onclick = removeSelected;
}

async function removeSelected() {
  const s = invState?.sel; if (!s) return;
  const r = await act(() => api(`/players/${invState.steamid}/inventory/remove`, { body: { container: s.k, slot: s.slot } }), t('inv.removed', { name: s.it.name }));
  if (r) loadInventory();
}
async function clearInventory() {
  const btn = $('#invClear'), label = btn.querySelector('span');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'; label.textContent = t('inv.clearConfirm');
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; label.textContent = t('inv.clear'); } }, 4000);
    return;
  }
  if (await act(() => api(`/players/${invState.steamid}/inventory/clear`, { body: {} }), t('inv.cleared'))) loadInventory();
}

// ======================================================================
// Estadísticas (gráficas en SVG propias, sin dependencias)
// ======================================================================
const C1 = '#2FA98F', C2 = '#C98418'; // paleta validada para fondo oscuro (daltonismo y contraste)
const st = { range: '7d', data: null, timer: null };
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
const fmtShort = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : fmtNum(n);
function chartTip(host) {
  let tip = host.querySelector('.ch-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'ch-tip'; tip.hidden = true; host.append(tip); }
  return tip;
}
function emptyChart(el, msg) { el.innerHTML = `<div class="chart-empty">${esc(msg)}</div>`; }

// Línea con área, cruz y tooltip. points: [{t, v, tip}]
function lineChart(el, points, { color = C1, fmtY = fmtShort, xFmt, gapMs = 20 * 60000, label = '' } = {}) {
  if (points.length < 2) return emptyChart(el, t('st.noData'));
  el.innerHTML = '';
  const W = el.clientWidth || 600, H = el.clientHeight || 240, m = { l: 44, r: 14, t: 12, b: 26 };
  const x0 = points[0].t, x1 = points[points.length - 1].t, max = niceMax(Math.max(...points.map(p => p.v)) * 1.05);
  const X = (tt) => m.l + (tt - x0) / Math.max(1, x1 - x0) * (W - m.l - m.r), Y = (v) => H - m.b - v / max * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  const g = svgEl('g', { class: 'grid' }), ax = svgEl('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, y = Y(v);
    g.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y }));
    const tx = svgEl('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }); tx.textContent = fmtY(v); ax.append(tx);
  }
  const ticks = Math.min(6, Math.floor((W - m.l - m.r) / 90));
  for (let i = 0; i <= ticks; i++) {
    const tt = x0 + (x1 - x0) * i / ticks;
    const tx = svgEl('text', { x: X(tt), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }); tx.textContent = xFmt(tt); ax.append(tx);
  }
  svg.append(g, ax);
  // Tramos: se corta la línea cuando el servidor estuvo apagado
  const segs = []; let cur = [];
  points.forEach((p, i) => { if (i && p.t - points[i - 1].t > gapMs) { segs.push(cur); cur = []; } cur.push(p); });
  segs.push(cur);
  for (const s of segs) {
    if (!s.length) continue;
    const d = s.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d: `${d} L${X(s[s.length - 1].t).toFixed(1)} ${Y(0)} L${X(s[0].t).toFixed(1)} ${Y(0)} Z`, fill: color, 'fill-opacity': '.14' }));
    svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const xh = svgEl('line', { class: 'xhair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4.5, fill: color, stroke: 'var(--steel-800)', 'stroke-width': 2, visibility: 'hidden' });
  const hit = svgEl('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' });
  svg.append(xh, dot, hit);
  el.append(svg);
  const tip = chartTip(el);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    const tt = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
    let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - tt) < Math.abs(points[best].t - tt)) best = i;
    const p = points[best], cx = X(p.t), cy = Y(p.v);
    xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
    tip.innerHTML = p.tip; tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(cx / W * r.width, 70), r.width - 70)}px`; tip.style.top = `${cy / H * r.height}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

// Barras agrupadas (2 px de separación, extremos redondeados apoyados en la base)
function barChart(el, labels, series, { tipTitle } = {}) {
  if (!labels.length) return emptyChart(el, t('st.noData'));
  el.innerHTML = `<div class="ch-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  const box = document.createElement('div'); box.style.cssText = 'position:relative;height:calc(100% - 30px)'; el.append(box);
  const W = box.clientWidth || 500, H = box.clientHeight || 170, m = { l: 36, r: 6, t: 8, b: 22 };
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.vals)));
  const Y = (v) => H - m.b - v / max * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const g = svgEl('g', { class: 'grid' }), ax = svgEl('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) { const v = max * i / 4, y = Y(v); g.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y })); const tx = svgEl('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }); tx.textContent = fmtShort(Math.round(v)); ax.append(tx); }
  svg.append(g, ax);
  const gw = (W - m.l - m.r) / labels.length, bw = Math.max(2, Math.min(18, (gw * 0.7 - 2 * (series.length - 1)) / series.length));
  const every = Math.ceil(labels.length / Math.floor((W - m.l) / 46));
  const tip = chartTip(box);
  labels.forEach((lb, i) => {
    const gx = m.l + gw * i + (gw - (bw * series.length + 2 * (series.length - 1))) / 2;
    series.forEach((s, k) => {
      const v = s.vals[i] || 0, x = gx + k * (bw + 2), y = Y(v), h = Y(0) - y, r = Math.min(4, bw / 2, h);
      if (v > 0) svg.append(svgEl('path', { d: `M${x} ${Y(0)} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + bw - r} Q${x + bw} ${y} ${x + bw} ${y + r} V${Y(0)} Z`, fill: s.color }));
    });
    if (i % every === 0) { const tx = svgEl('text', { x: m.l + gw * i + gw / 2, y: H - 6, 'text-anchor': 'middle' }); tx.textContent = lb.short; ax.append(tx); }
    const hit = svgEl('rect', { x: m.l + gw * i, y: m.t, width: gw, height: H - m.t - m.b, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      tip.innerHTML = `<b>${esc(lb.long)}</b>` + series.map(s => `<div class="row"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}: ${fmtNum(s.vals[i] || 0)}</div>`).join('') + (tipTitle ? tipTitle(i) : '');
      tip.hidden = false; const r = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max((m.l + gw * i + gw / 2) / W * r.width, 80), r.width - 80)}px`; tip.style.top = `${Y(Math.max(...series.map(s => s.vals[i] || 0))) / H * r.height}px`;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(hit);
  });
  box.append(svg);
}

// Mapa de calor: una sola tonalidad, de oscuro (pocos) a claro (muchos) sobre fondo oscuro
function heatColor(f) {
  const a = [30, 46, 44], b = [143, 224, 204];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`;
}
function renderHeat(hm) {
  const el = $('#stHeat'), max = Math.max(0, ...hm.flat().filter(v => v != null));
  if (!max) return emptyChart(el, t('st.noData'));
  const days = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'short' }));
  let h = '<div class="heat" role="table"><span></span>';
  for (let i = 0; i < 24; i++) h += `<span class="hh">${i % 3 === 0 ? i : ''}</span>`;
  hm.forEach((row, d) => {
    h += `<span class="hl">${esc(days[d])}</span>`;
    row.forEach((v, hr) => {
      const lab = t('st.heatTip', { d: days[d], h: `${String(hr).padStart(2, '0')}:00`, n: v == null ? '—' : String(v).replace('.', ',') });
      h += `<span class="hc" style="background:${v == null ? 'var(--steel-900)' : heatColor(v / max)}" data-tip="${esc(lab)}" aria-label="${esc(lab)}"></span>`;
    });
  });
  h += `</div><div class="heat-scale">${esc(t('st.heatLow'))}<i style="background:linear-gradient(90deg,${heatColor(0)},${heatColor(1)})"></i>${esc(t('st.heatHigh', { n: String(max).replace('.', ',') }))}</div>`;
  el.innerHTML = h;
  el.style.position = 'relative';
  const tip = chartTip(el);
  el.querySelector('.heat').addEventListener('pointerover', (e) => {
    const c = e.target.closest('.hc'); if (!c) return;
    tip.textContent = c.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    tip.style.left = `${cr.left - r.left + cr.width / 2}px`; tip.style.top = `${cr.top - r.top}px`;
  });
  el.querySelector('.heat').addEventListener('pointerleave', () => { tip.hidden = true; });
}

async function loadStats() {
  $$('#stRange button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === st.range)));
  try { st.data = await api('/stats?range=' + st.range); } catch (e) { toast(e.message, true); return; }
  renderStats();
  clearInterval(st.timer);
  st.timer = setInterval(() => { if (state.view !== 'stats') return clearInterval(st.timer); api('/stats?range=' + st.range).then(d => { st.data = d; renderStats(); }).catch(() => {}); }, 60000);
}
function renderStats() {
  const d = st.data, s = d.summary;
  const dt = (tt, o) => new Date(tt).toLocaleString(locale(), o);
  $('#stNote').textContent = d.range === 'wipe' && d.wipeStart ? t('st.sinceWipe', { d: dt(d.wipeStart, { day: 'numeric', month: 'long' }) }) : (d.samples ? '' : t('st.collecting'));
  const tile = (label, val, sub = '') => `<div class="kpi-tile"><small>${esc(label)}</small><b>${val}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  $('#stKpis').innerHTML = [
    tile(t('st.k.online'), fmtNum(d.online)),
    tile(t('st.k.peak'), fmtNum(s.peak.n), s.peak.t ? dt(s.peak.t, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''),
    tile(t('st.k.avg'), String(s.avg).replace('.', ',')),
    tile(t('st.k.uniques'), fmtNum(s.uniques), t('st.k.returning', { n: s.returning })),
    tile(t('st.k.new'), fmtNum(s.newcomers)),
    tile(t('st.k.hours'), fmtNum(Math.round(s.hours))),
    tile(t('st.k.fps'), s.fpsAvg ? fmtNum(s.fpsAvg) : '—', s.fpsMin ? t('st.k.fpsMin', { n: s.fpsMin }) : ''),
    tile(t('st.k.kills'), fmtNum(s.kills)),
  ].join('');
  const short = d.range === '24h';
  const xFmt = (tt) => dt(tt, short ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' });
  const when = (tt) => dt(tt, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#stPlayersSub').textContent = t('st.playersSub');
  const gap = Math.max(20 * 60000, (d.now - d.from) / 240 * 3);
  lineChart($('#chPlayers'), d.series.map(r => ({ t: r[0], v: r[1], tip: `<b>${esc(when(r[0]))}</b><div class="row"><span class="sw" style="background:${C1}"></span>${esc(t('st.tipAvg', { n: String(r[1]).replace('.', ',') }))}</div><div>${esc(t('st.tipPeak', { n: r[2] }))}${r[6] ? ' · ' + esc(t('st.tipQueue', { n: r[6] })) : ''}</div>` })), { xFmt, gapMs: gap, label: t('st.playersTitle') });
  lineChart($('#chFps'), d.series.map(r => ({ t: r[0], v: r[3], tip: `<b>${esc(when(r[0]))}</b>${esc(t('st.tipFps', { n: r[3] }))}` })), { xFmt, gapMs: gap, label: t('st.fpsTitle') });
  lineChart($('#chEnt'), d.series.map(r => ({ t: r[0], v: r[4], tip: `<b>${esc(when(r[0]))}</b>${esc(t('st.tipEnt', { n: fmtNum(r[4]) }))}` })), { xFmt, gapMs: gap, label: t('st.entTitle') });
  renderHeat(d.heatmap);
  const labels = d.daily.map(x => { const [y, mo, da] = x.d.split('-').map(Number); const dd = new Date(y, mo - 1, da); return { short: dd.toLocaleDateString(locale(), { day: 'numeric', month: 'numeric' }), long: dd.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' }) }; });
  barChart($('#chDaily'), labels, [
    { name: t('st.uniques'), color: C1, vals: d.daily.map(x => x.u) },
    { name: t('st.newcomers'), color: C2, vals: d.daily.map(x => x.n) },
  ], { tipTitle: (i) => `<div>${esc(t('st.tipHours', { n: String(d.daily[i].h).replace('.', ',') }))}</div>` });
  const nameCell = (p) => `<td><button class="link" data-hist="${esc(p.id)}">${esc(p.name)}</button>${p.online ? `<span class="dot-on" title="${esc(t('st.onlineNow'))}"></span>` : ''}</td>`;
  $('#stTopPlay tbody').innerHTML = d.topPlay.length ? d.topPlay.map((p, i) => `<tr><td class="rank-n">${i + 1}</td>${nameCell(p)}<td class="num">${String(p.hours).replace('.', ',')}</td><td class="num">${fmtNum(p.sessions)}</td><td>${p.first ? esc(dt(p.first, { day: 'numeric', month: 'short', year: 'numeric' })) : '—'}</td></tr>`).join('') : `<tr><td colspan="5" class="empty">${esc(t('st.noData'))}</td></tr>`;
  $('#stTopKills tbody').innerHTML = d.topKills.length ? d.topKills.map((p, i) => `<tr><td class="rank-n">${i + 1}</td>${nameCell(p)}<td class="num">${fmtNum(p.kills)}</td><td class="num">${fmtNum(p.deaths)}</td><td class="num">${String(p.kd).replace('.', ',')}</td><td class="num">${p.hs} %</td></tr>`).join('') : `<tr><td colspan="6" class="empty">${esc(t('st.noKills'))}</td></tr>`;
}
$$('#stRange button').forEach(b => b.onclick = () => { st.range = b.dataset.range; loadStats(); });
let stResize;
addEventListener('resize', () => { clearTimeout(stResize); stResize = setTimeout(() => { if (state.view === 'stats' && st.data) renderStats(); }, 200); });

// ======================================================================
// Rendimiento: diagnóstico del arranque y alertas
// ======================================================================
const PHASE_COLOR = { process: '#4E86D0', assets: '#C98418', world: '#2FA98F', mapupload: '#C2553F', plugins: '#A070D0' }; // validada para fondo oscuro
const pf = { data: null, timer: null };
const fmtSecs = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : t('pf.sec', { n: s }); };
async function loadPerf() {
  try { pf.data = await api('/perf'); } catch (e) { toast(e.message, true); return; }
  $('#navPerf').textContent = '';
  renderPerf();
  clearInterval(pf.timer);
  pf.timer = setInterval(async () => {
    if (state.view !== 'perf') return clearInterval(pf.timer);
    if (pf.data?.current && !pf.data.current.done) { try { pf.data = await api('/perf'); renderPerf(); } catch {} }
  }, 3000);
}
function renderPerf() {
  const d = pf.data, b = d.current && !d.current.done ? d.current : (d.boots[0] || d.current);
  const dt = (tt) => new Date(tt).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const live = b && !b.done;
  $('#pfBootWhen').textContent = b ? dt(b.t) : '';
  $('#pfTotal').textContent = b ? fmtSecs(b.total) : '—';
  const v = $('#pfVerdict');
  v.className = live ? 'is-live' : '';
  v.textContent = !b ? t('pf.noBoot') : live ? t('pf.booting') : !b.ok ? t('pf.bootStopped') : b.total < 180000 ? t('pf.fast') : b.total < 480000 ? t('pf.normal') : t('pf.slow');
  $('#pfFacts').innerHTML = !b ? '' : [
    `<span class="pf-fact">${esc(t(b.generated ? 'pf.mapGenerated' : 'pf.mapLoaded', { size: b.worldsize }))}</span>`,
    b.framework !== 'none' ? `<span class="pf-fact">${esc(t('pf.pluginsN', { n: b.plugins }))}${b.pluginErrors ? ` · <b>${esc(t('pf.errorsN', { n: b.pluginErrors }))}</b>` : ''}</span>` : '',
    `<span class="pf-fact">${esc(t(b.mapUploadFailed ? 'pf.uploadFail' : b.mapUploaded ? 'pf.uploadOk' : 'pf.uploadNone', { n: b.mapUploadFailed }))}</span>`,
    b.freeRamMB ? `<span class="pf-fact">${esc(t('pf.freeRam', { gb: (b.freeRamMB / 1024).toFixed(1).replace('.', ',') }))}</span>` : '',
  ].join('');
  const phases = b?.phases || [], total = phases.reduce((a, p) => a + p.ms, 0) || 1;
  $('#pfBar').innerHTML = phases.map((p, i) => `<i class="${live && i === phases.length - 1 ? 'is-live' : ''}" style="flex:${p.ms / total};background:${PHASE_COLOR[p.name] || '#7E8A95'}" title="${esc(t('pf.ph.' + p.name))}: ${esc(fmtSecs(p.ms))}"></i>`).join('');
  $('#pfBar').setAttribute('aria-label', phases.map(p => `${t('pf.ph.' + p.name)} ${fmtSecs(p.ms)}`).join(', '));
  $('#pfPhases').innerHTML = phases.length ? phases.map(p => `<li><i style="background:${PHASE_COLOR[p.name] || '#7E8A95'}"></i>${esc(t('pf.ph.' + p.name))} <b>${esc(fmtSecs(p.ms))}</b></li>`).join('') : `<li>${esc(t('pf.noPhases'))}</li>`;
  const tips = b?.advice || [];
  const icon = { high: 'alert', medium: 'alert', low: 'check' };
  $('#pfTips').innerHTML = tips.length ? tips.map(a => `<li class="sev-${a.sev}">${ic(icon[a.sev])}<div><b>${esc(t('pf.tip.' + a.code + '.title', a.p))}</b><p>${t('pf.tip.' + a.code + '.body', Object.fromEntries(Object.entries(a.p).map(([k, x]) => [k, esc(String(x))])))}</p></div></li>`).join('')
    : `<li><span></span><p class="empty">${esc(t(b ? 'pf.noTips' : 'pf.noBoot'))}</p></li>`;
  $('#pfPriority').checked = d.highPriority;
  const s = d.sys;
  $('#pfSys').innerHTML = [
    [t('pf.sysRam'), t('pf.sysRamVal', { free: String(s.freeRamGB).replace('.', ','), total: String(s.totalRamGB).replace('.', ',') })],
    [t('pf.sysCpu'), `${s.cpu} (${s.cpus})`],
    [t('pf.sysOs'), s.platform === 'win32' ? 'Windows' : s.platform === 'linux' ? 'Linux' : s.platform],
    [t('pf.sysMap'), String(d.server.worldsize)],
  ].map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('');
  $('#pfHist tbody').innerHTML = d.boots.length ? d.boots.map(x => `<tr><td>${esc(dt(x.t))}</td><td class="num">${esc(fmtSecs(x.total))}</td><td>${esc(t(x.generated ? 'pf.h.generated' : 'pf.h.loaded'))}</td><td class="num">${x.framework === 'none' ? '—' : fmtNum(x.plugins)}</td><td class="num">${x.advice.filter(a => a.code !== 'priority').length}</td><td>${x.ok ? `<span class="tag tag--ok">${esc(t('pf.h.ok'))}</span>` : `<span class="tag">${esc(t('pf.h.stopped'))}</span>`}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">${esc(t('pf.noBoot'))}</td></tr>`;
  const f = $('#perfForm').elements, st = d.settings;
  for (const k of ['fpsMin', 'fpsMinutes', 'ramPct', 'hangMinutes']) f[k].value = st[k];
  for (const k of ['enabled', 'autoRestartHang', 'autoRestartFps', 'discord']) f[k].checked = !!st[k];
  $('#pfEvents').innerHTML = d.events.length ? d.events.map(e => `<li class="sev-${e.sev}"><time>${esc(dt(e.t))}</time><div><b>${esc(t('pf.ev.' + e.code + '.title', e.p))}</b><small>${esc(t('pf.ev.' + e.code + '.detail', e.p))}</small></div></li>`).join('') : `<li><span></span><span class="empty" style="color:var(--muted)">${esc(t('pf.noEvents'))}</span></li>`;
  applyPerms($('[data-section="perf"]'));
}
$('#pfPriority').onchange = async (e) => {
  const r = await act(() => api('/perf', { method: 'PUT', body: { highPriority: e.target.checked } }), t(e.target.checked ? 'pf.priorityOn' : 'pf.priorityOff'));
  if (r) { pf.data = r; renderPerf(); } else e.target.checked = !e.target.checked;
};
$('#perfForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements, body = {};
  for (const k of ['fpsMin', 'fpsMinutes', 'ramPct', 'hangMinutes']) body[k] = +f[k].value;
  for (const k of ['enabled', 'autoRestartHang', 'autoRestartFps', 'discord']) body[k] = f[k].checked;
  const r = await act(() => api('/perf', { method: 'PUT', body }), t('pf.saved'));
  if (r) { pf.data = r; renderPerf(); }
};
function onPerf(ev) {
  toast(t('pf.ev.' + ev.code + '.title', ev.p), ev.sev !== 'low');
  if (state.view === 'perf') loadPerf();
  else if (ev.sev !== 'low') $('#navPerf').textContent = '!';
}

// ======================================================================
// Bot de Discord
// ======================================================================
const dcS = { data: null, timer: null };
async function loadDiscord() {
  try { dcS.data = await api('/discord'); } catch (e) { toast(e.message, true); return; }
  renderDiscord();
  clearInterval(dcS.timer);
  dcS.timer = setInterval(async () => {
    if (state.view !== 'discord') return clearInterval(dcS.timer);
    try { dcS.data = await api('/discord'); renderDiscordStatus(); } catch {}
  }, 4000);
}
function renderDiscordStatus() {
  const d = dcS.data, st = d.state;
  const box = $('#dcStatus');
  const status = !d.settings.enabled ? 'off' : st.status;
  box.dataset.st = status;
  $('#dcState').textContent = t('dc.st.' + status, { name: st.user || '' });
  $('#dcDetail').textContent = status === 'error' ? (st.error || '') : status === 'ready' ? t(st.guildId ? 'dc.readyGuild' : 'dc.readyGlobal') : status === 'off' ? t('dc.offHint') : '';
  $('#dcInvite').hidden = !d.invite;
  if (d.invite) $('#dcInvite').href = d.invite;
}
function renderDiscord() {
  const s = dcS.data.settings, f = $('#dcForm').elements;
  for (const k of ['enabled', 'relayToDiscord', 'relayToGame', 'commands', 'presence']) f[k].checked = !!s[k];
  f.chatChannelId.value = s.chatChannelId || '';
  f.token.value = '';
  f.token.placeholder = s.hasToken ? s.tokenHint : '';
  $('#dcTokenHint').textContent = t(s.hasToken ? 'dc.tokenSaved' : 'dc.tokenHint');
  $('#dcClear').hidden = !s.hasToken;
  renderDiscordStatus();
  applyPerms($('[data-section="discord"]'));
}
$('#dcForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements, body = { chatChannelId: f.chatChannelId.value.trim() };
  for (const k of ['enabled', 'relayToDiscord', 'relayToGame', 'commands', 'presence']) body[k] = f[k].checked;
  if (f.token.value.trim()) body.token = f.token.value.trim();
  const r = await act(() => api('/discord', { method: 'PUT', body }), t('dc.saved'));
  if (r) { dcS.data = r; renderDiscord(); setTimeout(loadDiscord, 3000); }
};
$('#dcClear').onclick = async () => {
  if (!await confirmDialog({ title: t('dc.clearToken'), body: esc(t('dc.clearBody')), confirm: t('dc.clearToken'), danger: true })) return;
  const r = await act(() => api('/discord', { method: 'PUT', body: { clearToken: true, enabled: false } }), t('dc.saved'));
  if (r) { dcS.data = r; renderDiscord(); }
};

// ======================================================================
// Tickets de reportes F7
// ======================================================================
const tk = { status: 'active', data: null };
const tkKind = (k) => (STR['tk.kind.' + k] || BASE['tk.kind.' + k] ? t('tk.kind.' + k) : k);
function setTicketBadge(c) {
  if (!c) return;
  const n = (c.open || 0);
  $('#navTickets').textContent = n || '';
  $('#navTickets').title = t('tk.badge', { o: c.open || 0, p: c.progress || 0 });
}
async function loadTickets() {
  $$('#tkFilter button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.st === tk.status)));
  try { tk.data = await api('/tickets?status=' + tk.status); } catch (e) { toast(e.message, true); return; }
  setTicketBadge(tk.data.counts);
  const c = tk.data.counts;
  $('#tkKpis').innerHTML = [
    ['open', c.open, 'tk.k.open'], ['progress', c.progress, 'tk.k.progress'],
    ['multi', tk.data.items.filter(x => x.status !== 'closed' && x.reporters > 1).length, 'tk.k.multi'],
  ].map(([k, v, l]) => `<div class="tk-kpi tk-kpi--${k}"><b>${fmtNum(v)}</b><span>${esc(t(l))}</span></div>`).join('');
  const tb = $('#tkTable tbody');
  tb.innerHTML = tk.data.items.length ? tk.data.items.map(x => `
    <tr class="tk-row" data-ticket="${x.id}" tabindex="0">
      <td class="num"><b>${x.id}</b></td>
      <td class="who"><b>${esc(x.target.name)}</b><small><code>${esc(x.target.id)}</code></small></td>
      <td><span class="tk-rep${x.reporters > 1 ? ' tk-rep--multi' : ''}">${esc(t('tk.repCount', { n: x.reports, r: x.reporters }))}</span></td>
      <td class="tk-reason">${esc(x.lastSubject || '—')}${x.kinds.length ? `<small>${x.kinds.map(k => esc(tkKind(k))).join(' · ')}</small>` : ''}</td>
      <td>${x.assignee ? esc(x.assignee) : `<span class="muted">${esc(t('tk.unassigned'))}</span>`}</td>
      <td><span title="${esc(fmtDate(x.updated))}">${esc(t('tk.ago', { d: fmtDur((Date.now() - (x.closed?.t || x.updated)) / 1000) }))}</span></td>
      <td><span class="tag tk-st tk-st--${x.status}">${esc(x.status === 'closed' ? t('tk.res.' + x.closed.resolution) : t('tk.st.' + x.status))}</span></td>
    </tr>`).join('') : `<tr class="empty"><td colspan="7"><b>${esc(t(tk.status === 'closed' ? 'tk.emptyClosed' : 'tk.empty'))}</b>${esc(t('tk.emptySub'))}</td></tr>`;
}
$$('#tkFilter button').forEach(b => b.onclick = () => { tk.status = b.dataset.st; loadTickets(); });
document.addEventListener('click', (e) => { const r = e.target.closest('[data-ticket]'); if (r && !e.target.closest('a,button')) openTicket(r.dataset.ticket); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('[data-ticket]')) openTicket(e.target.dataset.ticket); });

function ticketBody(d) {
  const mod = d.mod || {}, pl = d.player || {};
  const reps = d.reports.slice().reverse().map(r => `
    <li><div class="tk-rh"><b>${esc(r.reporterName || r.reporter)}</b>${r.kind ? `<span class="tag">${esc(tkKind(r.kind))}</span>` : ''}<small>${esc(fmtDate(r.t))}</small></div>
    ${r.subject ? `<p class="tk-subj">${esc(r.subject)}</p>` : ''}${r.message ? `<p class="tk-msg">${esc(r.message)}</p>` : ''}</li>`).join('');
  const coms = d.comments.map(c => `<li class="${c.system ? 'tk-sys' : ''}"><div class="tk-rh"><b>${esc(c.by)}</b><small>${esc(fmtDate(c.t))}</small></div><p>${esc(c.system ? t('tk.sys.' + c.system) : c.text)}</p></li>`).join('');
  const facts = [
    [t('tk.f.reportsTotal'), fmtNum(pl.totals?.reports || d.reports.length)],
    [t('tk.f.warnings'), fmtNum((mod.warnings || []).length)],
    [t('tk.f.alerts'), fmtNum((pl.alerts || []).length)],
    [t('tk.f.state'), pl.banned ? t('tk.banned') : mod.tempban ? t('tk.tempbanned') : mod.mute ? t('tk.muted') : t('tk.clean')],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const closed = d.status === 'closed';
  const canClose = can('players.moderate');
  return `
    <div class="tk-detail">
      <div class="tk-top">
        <div><span class="tag tk-st tk-st--${d.status}">${esc(closed ? t('tk.res.' + d.closed.resolution) : t('tk.st.' + d.status))}</span>
        <span class="muted">${esc(t('tk.openedAt', { d: fmtDate(d.created) }))}${d.assignee ? ' · ' + esc(t('tk.assignedTo', { u: d.assignee })) : ''}</span></div>
        <button type="button" class="btn btn-sm" data-hist="${esc(d.target.id)}"><svg class="i"><use href="#i-eye"/></svg>${esc(t('tk.history'))}</button>
      </div>
      <dl class="facts facts--inline">${facts}</dl>
      ${closed ? `<p class="tk-closedline">${esc(t('tk.closedBy', { u: d.closed.by, d: fmtDate(d.closed.t) }))}${d.closed.note ? ' — ' + esc(d.closed.note) : ''}</p>` : ''}
      <div class="tk-cols">
        <div><h4>${esc(t('tk.reportsTitle', { n: d.reports.length }))}</h4><ul class="tk-feed">${reps}</ul></div>
        <div><h4>${esc(t('tk.commentsTitle'))}</h4><ul class="tk-feed">${coms || `<li class="tk-sys"><p>${esc(t('tk.noComments'))}</p></li>`}</ul>
          ${canClose ? `<div class="tk-comment"><textarea id="tkCom" rows="2" maxlength="2000" placeholder="${esc(t('tk.commentPh'))}"></textarea><button type="button" class="btn btn-sm" id="tkComBtn">${esc(t('tk.comment'))}</button></div>` : ''}
        </div>
      </div>
      ${!closed && canClose ? `
      <div class="tk-close">
        <h4>${esc(t('tk.closeTitle'))}</h4>
        <div class="grid-fields">
          <label class="field"><span>${esc(t('tk.resolution'))}</span><select id="tkRes">${['none', 'warn', 'mute', 'kick', 'tempban', 'ban'].map(r => `<option value="${r}"${(['kick'].includes(r) && !can('players.kick')) || (['tempban', 'ban'].includes(r) && !can('players.ban')) ? ' disabled' : ''}>${esc(t('tk.res.' + r))}</option>`).join('')}</select></label>
          <label class="field" id="tkMinWrap" hidden><span>${esc(t('tk.minutes'))}</span><input id="tkMin" type="number" min="1" value="1440"></label>
        </div>
        <label class="field"><span>${esc(t('tk.closeNote'))}</span><input id="tkNote" maxlength="120" placeholder="${esc(t('tk.closeNotePh'))}"></label>
        <label class="switch"><input type="checkbox" id="tkNotify" checked><span class="switch-ui"></span><span>${esc(t('tk.notify'))}</span></label>
      </div>` : ''}
    </div>`;
}
async function openTicket(id) {
  let d = await act(() => api('/tickets/' + id)); if (!d || d === true) return;
  const actions = [];
  const closed = d.status === 'closed';
  if (can('players.moderate')) {
    if (closed) actions.push({ label: t('tk.reopen'), cls: 'btn-quiet', value: 'reopen' });
    else {
      actions.push(d.assignee === state.me.username ? { label: t('tk.unassign'), cls: 'btn-quiet', value: 'unassign' } : { label: t('tk.assignMe'), cls: 'btn-quiet', value: 'assign' });
      actions.push({ label: t('tk.closeBtn'), cls: 'btn-primary', get: () => ({ act: 'close', resolution: $('#tkRes').value, minutes: Number($('#tkMin').value), note: $('#tkNote').value, notify: $('#tkNotify').checked }) });
    }
  }
  actions.unshift({ label: t('common.close'), cls: 'btn-quiet', value: null });
  const p = openDialog({ title: t('tk.dlgTitle', { n: d.id, name: d.target.name }), body: ticketBody(d), wide: true, actions });
  const res = $('#tkRes');
  if (res) res.onchange = () => { $('#tkMinWrap').hidden = !['mute', 'tempban'].includes(res.value); $('#tkMin').value = res.value === 'mute' ? 30 : 1440; };
  const cb = $('#tkComBtn');
  if (cb) cb.onclick = async () => {
    const r = await act(() => api(`/tickets/${id}/comment`, { body: { text: $('#tkCom').value } }));
    if (r && r !== true) { closeDialog(null); openTicket(id); }
  };
  const v = await p;
  if (!v) return;
  if (v === 'assign' || v === 'unassign' || v === 'reopen') {
    await act(() => api(`/tickets/${id}/${v}`, { body: {} }), t('tk.ok.' + v));
  } else if (v.act === 'close') {
    if (v.resolution === 'ban' && !await confirmDialog({ title: t('tk.res.ban'), body: esc(t('tk.banConfirm', { name: d.target.name })), confirm: t('tk.res.ban'), danger: true })) return openTicket(id);
    const r = await act(() => api(`/tickets/${id}/close`, { body: v }));
    if (r && r !== true) toast(t(r.notified ? 'tk.ok.closedNotified' : 'tk.ok.closed', { n: r.notified }));
  }
  if (state.view === 'tickets') loadTickets();
}

// ======================================================================
// VIP con caducidad
// ======================================================================
const vp = { data: null, timer: null };
async function loadVip() {
  try { vp.data = await api('/vip'); } catch (e) { toast(e.message, true); return; }
  renderVip();
  api('/players').then(l => { $('#vipPlayers').innerHTML = (l || []).map(p => `<option value="${esc(p.SteamID)}">${esc(p.DisplayName)}</option>`).join(''); }).catch(() => {});
  clearInterval(vp.timer);
  vp.timer = setInterval(() => { if (state.view !== 'vip') return clearInterval(vp.timer); renderVipTable(); }, 30000);
}
function renderVipTable() {
  const g = vp.data.grants, tb = $('#vipTable tbody');
  $('#vipCount').textContent = t('vip.count', { n: g.length });
  $('#navVip').textContent = g.length || '';
  tb.innerHTML = g.length ? g.map(x => {
    const left = x.until ? (x.until - Date.now()) / 1000 : null;
    const ends = x.until ? `<b>${esc(left > 0 ? fmtDur(left) : t('vip.expiringNow'))}</b><small>${esc(fmtDate(x.until))}</small>` : `<b>${esc(t('vip.permanent'))}</b>`;
    const flags = x.pendingRemove ? `<span class="tag tag--busy">${esc(t('vip.pendingRemove'))}</span>` : !x.synced ? `<span class="tag tag--busy" title="${esc(t('vip.unsyncedHint'))}">${esc(t('vip.unsynced'))}</span>` : '';
    return `<tr class="${x.expiring ? 'vip-soon' : ''}">
      <td class="who"><b>${esc(x.name)}</b><small><code>${esc(x.steamid)}</code></small></td>
      <td><span class="tag vip-group">${esc(x.group)}</span> ${flags}</td>
      <td class="vip-ends">${ends}</td>
      <td><span title="${esc(fmtDate(x.since))}">${esc(x.by)}</span>${x.note ? `<small>${esc(x.note)}</small>` : ''}</td>
      <td class="row-actions" data-perm="perms">
        <button class="btn btn-sm" data-vip-ext="${esc(x.steamid)}" data-group="${esc(x.group)}" data-name="${esc(x.name)}"><svg class="i"><use href="#i-plus"/></svg>${esc(t('vip.extend'))}</button>
        <button class="btn btn-sm btn-quiet btn-icon" data-vip-del="${esc(x.steamid)}" data-group="${esc(x.group)}" data-name="${esc(x.name)}" title="${esc(t('vip.remove'))}" aria-label="${esc(t('vip.remove'))}"><svg class="i"><use href="#i-trash"/></svg></button>
      </td></tr>`;
  }).join('') : `<tr class="empty"><td colspan="5"><b>${esc(t('vip.empty'))}</b>${esc(t('vip.emptySub'))}</td></tr>`;
  applyPerms($('#vipTable'));
}
function renderVip() {
  const s = vp.data.settings;
  $('#vipGroupSel').innerHTML = s.groups.map(g => `<option${g === s.defaultGroup ? ' selected' : ''}>${esc(g)}</option>`).join('');
  const gf = $('#vipGrant').elements;
  if (!gf.days.value) gf.days.value = s.defaultDays;
  const f = $('#vipSettings').elements;
  f.groups.value = s.groups.join(', '); f.defaultDays.value = s.defaultDays; f.warnHours.value = s.warnHours; f.notify.checked = !!s.notify; f.skipQueue.checked = !!s.skipQueue;
  $('#vipVanilla').hidden = state.status.framework !== 'none';
  renderVipTable();
  const h = vp.data.history;
  $('#vipHist').innerHTML = h.length ? h.slice(0, 30).map(x => `<li><div class="wp-date"><b>${esc(x.name)} · ${esc(x.group)}</b><small>${esc(fmtDate(x.ended))} · ${esc(t('vip.reason.' + (x.reason === 'expired' ? 'expired' : 'removed'), { u: x.by }))}</small></div></li>`).join('') : `<li class="wp-empty">${esc(t('vip.noHistory'))}</li>`;
  applyPerms($('[data-section="vip"]'));
}
$$('#vipPresets [data-days]').forEach(b => b.onclick = () => { $('#vipGrant').elements.days.value = b.dataset.days; });
$('#vipGrant').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const raw = f.player.value.trim();
  const opt = [...$('#vipPlayers').options].find(o => o.value === raw || o.textContent.toLowerCase() === raw.toLowerCase());
  const steamid = opt ? opt.value : raw;
  if (!/^\d{17}$/.test(steamid)) return toast(t('err.bad_steamid'), true);
  const days = Number(f.days.value);
  const r = await act(() => api('/vip', { body: { steamid, name: opt?.textContent, group: f.group.value, days, note: f.note.value } }), t(days === 0 ? 'vip.okPerm' : 'vip.ok', { n: days }));
  if (r && r !== true) { vp.data = r; f.player.value = ''; f.note.value = ''; renderVip(); }
};
$('#vipSettings').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const groups = f.groups.value.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
  const r = await act(() => api('/vip', { method: 'PUT', body: { groups, defaultGroup: groups[0], defaultDays: Number(f.defaultDays.value), warnHours: Number(f.warnHours.value), notify: f.notify.checked, skipQueue: f.skipQueue.checked } }), t('vip.saved'));
  if (r && r !== true) { vp.data = r; renderVip(); }
};
document.addEventListener('click', async (e) => {
  const ext = e.target.closest('[data-vip-ext]'), del = e.target.closest('[data-vip-del]');
  if (ext) {
    const v = await promptDialog({ title: t('vip.extendTitle', { name: ext.dataset.name }), label: t('vip.extendLabel'), value: String(vp.data.settings.defaultDays), confirm: t('vip.extend') });
    if (v === null) return;
    const r = await act(() => api('/vip', { body: { steamid: ext.dataset.vipExt, group: ext.dataset.group, name: ext.dataset.name, days: Number(v) } }), t('vip.extended'));
    if (r && r !== true) { vp.data = r; renderVip(); }
  }
  if (del) {
    if (!await confirmDialog({ title: t('vip.remove'), body: esc(t('vip.removeBody', { name: del.dataset.name, group: del.dataset.group })), confirm: t('vip.remove'), danger: true })) return;
    const r = await act(() => api(`/vip/${del.dataset.vipDel}/${encodeURIComponent(del.dataset.group)}`, { method: 'DELETE' }), t('vip.removed'));
    if (r && r !== true) { vp.data = r; renderVip(); }
  }
});

// ======================================================================
// Staff en el juego (/staff)
// ======================================================================
const sf = { data: null };
async function loadStaff() {
  try { sf.data = await api('/staff'); } catch (e) { toast(e.message, true); return; }
  renderStaff();
  api('/players').then(l => { $('#stfPlayers').innerHTML = (l || []).map(p => `<option value="${esc(p.SteamID)}">${esc(p.DisplayName)}</option>`).join(''); }).catch(() => {});
}
function renderStaff() {
  const d = sf.data, tb = $('#stfTable tbody');
  const w = $('#stfWarn');
  w.hidden = d.bridge;
  if (!d.bridge) w.innerHTML = t(d.rcon ? 'stf.noBridge' : 'stf.offline');
  tb.innerHTML = d.members.length ? d.members.map(m => `<tr>
      <td class="who"><b>${esc(m.name)}</b><small><code>${esc(m.steamid)}</code></small></td>
      <td><span class="tag stf-lvl stf-lvl--${m.level}">${esc(t('stf.lvl.' + m.level))}</span>${m.synced ? '' : ` <span class="tag tag--busy" title="${esc(t('vip.unsyncedHint'))}">${esc(t('vip.unsynced'))}</span>`}</td>
      <td><span title="${esc(fmtDate(m.since))}">${esc(m.by)}</span><small>${esc(new Date(m.since).toLocaleDateString(locale()))}</small></td>
      <td class="row-actions" data-perm="perms">
        <button class="btn btn-sm" data-stf-level="${esc(m.steamid)}" data-to="${m.level === 'admin' ? 'mod' : 'admin'}" data-name="${esc(m.name)}">${esc(t(m.level === 'admin' ? 'stf.toMod' : 'stf.toAdmin'))}</button>
        <button class="btn btn-sm btn-quiet btn-icon" data-stf-del="${esc(m.steamid)}" data-name="${esc(m.name)}" title="${esc(t('stf.remove'))}" aria-label="${esc(t('stf.remove'))}"><svg class="i"><use href="#i-trash"/></svg></button>
      </td></tr>`).join('') : `<tr class="empty"><td colspan="4"><b>${esc(t('stf.empty'))}</b>${esc(t('stf.emptySub'))}</td></tr>`;
  applyPerms($('[data-section="staff"]'));
}
$('#stfForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const raw = f.player.value.trim();
  const opt = [...$('#stfPlayers').options].find(o => o.value === raw || o.textContent.toLowerCase() === raw.toLowerCase());
  const steamid = opt ? opt.value : raw;
  if (!/^\d{17}$/.test(steamid)) return toast(t('err.bad_steamid'), true);
  const r = await act(() => api('/staff', { body: { steamid, name: opt?.textContent, level: f.level.value } }), t('stf.added'));
  if (r && r !== true) { sf.data = r; f.player.value = ''; renderStaff(); }
};
$('#stfSync').onclick = async () => { const r = await act(() => api('/staff/sync', { body: {} }), t('stf.synced')); if (r && r !== true) { sf.data = r; renderStaff(); } };
document.addEventListener('click', async (e) => {
  const lv = e.target.closest('[data-stf-level]'), del = e.target.closest('[data-stf-del]');
  if (lv) {
    const r = await act(() => api('/staff', { body: { steamid: lv.dataset.stfLevel, name: lv.dataset.name, level: lv.dataset.to } }), t('stf.changed'));
    if (r && r !== true) { sf.data = r; renderStaff(); }
  }
  if (del) {
    if (!await confirmDialog({ title: t('stf.remove'), body: esc(t('stf.removeBody', { name: del.dataset.name })), confirm: t('stf.remove'), danger: true })) return;
    const r = await act(() => api('/staff/' + del.dataset.stfDel, { method: 'DELETE' }), t('stf.removed'));
    if (r && r !== true) { sf.data = r; renderStaff(); }
  }
});

// ======================================================================
// Tienda (Tebex)
// ======================================================================
const sh = { data: null, timer: null };
const SH_EXAMPLES = [
  ['sh.ex.vip', 'scrapwarden.vip {id} vip 30'],
  ['sh.ex.group', 'oxide.usergroup add {id} vip'],
  ['sh.ex.perm', 'oxide.grant user {id} kits.vip'],
  ['sh.ex.item', 'inventory.giveto {id} rifle.ak 1'],
  ['sh.ex.say', 'say "{username} ❤"'],
];
async function loadStore() {
  try { sh.data = await api('/store'); } catch (e) { toast(e.message, true); return; }
  renderStore();
  clearInterval(sh.timer);
  sh.timer = setInterval(async () => {
    if (state.view !== 'store') return clearInterval(sh.timer);
    try { sh.data = await api('/store'); renderStoreStatus(); renderStoreTable(); } catch {}
  }, 10000);
}
function renderStoreStatus() {
  const d = sh.data, st = d.state, s = d.settings;
  const status = !s.enabled || !s.hasSecret ? 'off' : st.status;
  $('#shStatus').dataset.st = status === 'waiting' ? 'connecting' : status;
  $('#shState').textContent = t('sh.st.' + status, { name: st.account?.name || '' });
  const bits = [];
  if (status === 'error') bits.push(msgText(st.error));
  if (status === 'waiting') bits.push(t('sh.waitRcon'));
  if (st.lastCheck) bits.push(t('sh.lastCheck', { d: fmtTime(st.lastCheck) }));
  if (st.nextCheck && status !== 'off') bits.push(t('sh.nextCheck', { d: fmtTime(st.nextCheck) }));
  if (st.pending) bits.push(t('sh.pending', { n: st.pending }));
  if (status === 'off') bits.push(t('sh.offHint'));
  $('#shDetail').textContent = bits.join(' · ');
  $('#shCheck').hidden = status === 'off' || !can('server.config');
}
function renderStoreTable() {
  const d = sh.data;
  $('#shTotals').textContent = t('sh.totals', { n: d.totals.payments, c: d.totals.commands });
  const tb = $('#shTable tbody');
  tb.innerHTML = d.purchases.length ? d.purchases.map(p => `
    <tr>
      <td>${esc(fmtDate(p.t))}</td>
      <td class="who"><b>${esc(p.name || '—')}</b>${p.steamid ? `<small><code>${esc(p.steamid)}</code></small>` : ''}</td>
      <td>${p.payment != null ? `<code>#${esc(p.payment)}</code>` : '—'}</td>
      <td class="sh-lines">${p.commands.map(c => `<code class="${c.ok ? '' : 'is-bad'}" title="${esc(c.ok ? '' : msgText(c.error))}">${esc(c.line)}</code>`).join('')}</td>
      <td><span class="tag ${p.ok ? 'tag--ok' : p.retry ? 'tag--busy' : 'tag--err'}">${esc(t(p.ok ? 'sh.ok' : p.retry ? 'sh.retry' : 'sh.failed'))}</span></td>
    </tr>`).join('') : `<tr class="empty"><td colspan="5"><b>${esc(t('sh.empty'))}</b>${esc(t('sh.emptySub'))}</td></tr>`;
}
function renderStore() {
  const s = sh.data.settings, f = $('#shForm').elements;
  for (const k of ['enabled', 'announce', 'discord']) f[k].checked = !!s[k];
  $('#shVanilla').hidden = state.status.framework !== 'none';
  f.secret.value = '';
  f.secret.placeholder = s.hasSecret ? s.secretHint : '';
  $('#shSecretHint').textContent = t(s.hasSecret ? 'sh.secretSaved' : 'sh.secretHint');
  $('#shClear').hidden = !s.hasSecret;
  $('#shCmds').innerHTML = SH_EXAMPLES.map(([k, c]) => `<div class="sh-cmd"><span>${esc(t(k))}</span><code>${esc(c)}</code><button type="button" class="btn btn-sm btn-quiet btn-icon" data-copy="${esc(c)}" title="${esc(t('sh.copy'))}" aria-label="${esc(t('sh.copy'))}" data-perm-free>${ic('copy')}</button></div>`).join('');
  renderStoreStatus();
  renderStoreTable();
  applyPerms($('[data-section="store"]'));
}
$('#shForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements, body = {};
  for (const k of ['enabled', 'announce', 'discord']) body[k] = f[k].checked;
  if (f.secret.value.trim()) body.secret = f.secret.value.trim();
  if (body.enabled && !body.secret && !sh.data.settings.hasSecret) return toast(t('err.store_no_secret'), true);
  const r = await act(() => api('/store', { method: 'PUT', body }), t('sh.saved'));
  if (r && r !== true) { sh.data = r; renderStore(); setTimeout(loadStore, 3000); }
};
$('#shTest').onclick = async () => {
  const r = await act(() => api('/store/test', { body: { secret: $('#shForm').elements.secret.value.trim() } }));
  if (r && r !== true) toast(t('sh.testOk', { name: r.account.name || r.account.domain || '?', server: r.server || '—' }));
};
$('#shCheck').onclick = async () => {
  const r = await act(() => api('/store/check', { body: {} }), t('sh.checked'));
  if (r && r !== true) { sh.data = r; renderStoreStatus(); renderStoreTable(); }
};
$('#shClear').onclick = async () => {
  if (!await confirmDialog({ title: t('sh.clear'), body: esc(t('sh.clearBody')), confirm: t('sh.clear'), danger: true })) return;
  const r = await act(() => api('/store', { method: 'PUT', body: { clearSecret: true } }), t('sh.saved'));
  if (r && r !== true) { sh.data = r; renderStore(); }
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('sh.copied')); } catch { toast(b.dataset.copy); }
});

// ======================================================================
// Versión y aviso de actualizaciones
// ======================================================================
function renderUpdate(u) {
  if (!u) return;
  state.update = u;
  $('#railVer').textContent = 'v' + u.current; $('#railVer').title = 'Scrapwarden v' + u.current;
  $('#betaTag').hidden = !u.beta;
  $('#updBeta').hidden = !u.beta;
  $('#updPill').hidden = !u.available;
  if (u.available) { $('#updPill').href = u.url; $('#updPillText').textContent = t('upd.pill', { v: u.latest }); $('#updPill').title = t('upd.pillTitle', { v: u.latest, c: u.current }); }
  if (!$('#updState')) return;
  $('#updOn').checked = !!u.enabled;
  $('#updState').textContent = !u.enabled ? t('upd.off', { c: u.current })
    : u.available ? t('upd.availableLong', { v: u.latest, c: u.current })
    : u.error ? t('upd.error', { c: u.current })
    : t('upd.upToDate', { c: u.current });
  $('#updGet').hidden = !u.available;
  if (u.available) $('#updGet').href = u.url;
}
async function loadUpdate() { try { renderUpdate(await api('/update')); } catch {} }
$('#updCheck').onclick = async () => { const r = await act(() => api('/update/check', { body: {} })); if (r && r !== true) { renderUpdate(r); if (!r.available && !r.error) toast(t('upd.upToDateToast')); } };
$('#updOn').onchange = async (e) => { const r = await act(() => api('/update', { method: 'PUT', body: { enabled: e.target.checked } })); if (r && r !== true) renderUpdate(r); };

// ======================================================================
// Reportar un fallo (abre GitHub con los datos técnicos rellenados)
// ======================================================================
const BUG_URL = 'https://github.com/jvlsile/scrapwarden/issues/new';
function diagText(d) {
  const ua = navigator.userAgent.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/)?.[0] || 'browser';
  return [
    `Scrapwarden: ${d.version}`,
    `Panel OS: ${d.os} ${d.osRelease} · Node ${d.node}`,
    `Rust server files: ${d.serverPlatform} · branch ${d.branch} · map ${d.worldSize}`,
    `Framework: ${d.framework} · ScrapwardenBridge: ${d.bridge}`,
    `Server: ${d.status} · RCON ${d.rcon ? 'connected' : 'disconnected'}`,
    `Panel language: ${LANG} · Browser: ${ua}`,
    `Section: ${state.view}`,
    d.bridgeError ? `Bridge error: ${d.bridgeError}` : '',
  ].filter(Boolean).join('\n');
}
$('#bugBtn').onclick = async () => {
  let d;
  try { d = await api('/diag'); } catch (e) { d = { version: state.update?.current || '?', os: '?', osRelease: '', node: '?', serverPlatform: '?', branch: '?', worldSize: '?', framework: '?', bridge: '?', status: '?', rcon: false }; }
  const text = diagText(d);
  const fw = { none: 'Vanilla', oxide: 'Oxide', carbon: 'Carbon' }[d.framework];
  const q = new URLSearchParams({ template: 'bug_report.yml', version: d.version, logs: text });
  if (d.os === 'Windows' || d.os === 'Linux') q.set('os', d.os);
  if (fw) q.set('framework', fw);
  const url = `${BUG_URL}?${q}`;
  const v = await openDialog({
    title: t('bug.title'), wide: true,
    body: `<p>${t('bug.intro')}</p><ol class="bug-steps">${t('bug.steps')}</ol>
      <p class="bug-label">${esc(t('bug.dataLabel'))}</p><pre class="bug-diag">${esc(text)}</pre>
      <p class="field-hint">${t('bug.privacy')}</p>`,
    actions: [cancelAct(), { label: t('bug.copy'), cls: 'btn-quiet', value: 'copy' }, { label: t('bug.open'), cls: 'btn-primary', value: 'open' }],
  });
  if (v === 'copy') { try { await navigator.clipboard.writeText(text); toast(t('bug.copied')); } catch { toast(t('common.copyFailed'), true); } }
  if (v === 'open') window.open(url, '_blank', 'noopener');
};

// ======================================================================
// Modo del servidor: nuevo, importar uno existente o remoto por RCON
// ======================================================================
const isRemoteMode = () => state.status?.mode === 'remote';
function renderInsMode() {
  const m = state.insMode || 'new';
  $$('.mode-card').forEach(b => { const on = b.dataset.mode === m; b.setAttribute('aria-selected', String(on)); b.classList.toggle('is-on', on); });
  $('#insNew').hidden = m !== 'new';
  $('#insImport').hidden = m !== 'import';
  $('#insRemote').hidden = m !== 'remote';
  if (m === 'remote') loadRemote();
}
$$('.mode-card').forEach(b => b.onclick = () => { state.insMode = b.dataset.mode; renderInsMode(); });

// --- Importar ---
async function impBrowse(dir) {
  const r = await act(() => api('/import/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : ''))); if (!r || r === true) return;
  state.impCur = r;
  $('#impBrowser').hidden = false;
  $('#impCur').textContent = r.dir || t('imp.drives');
  $('#impUp').disabled = r.parent === null;
  $('#impPick').hidden = !r.isServer;
  $('#impDirs').innerHTML = r.dirs.length ? r.dirs.map(d => `<li><button type="button" data-impdir="${esc(d.path)}">${ic('archive')}${esc(d.name)}</button></li>`).join('') : `<li class="empty">${esc(t('imp.noDirs'))}</li>`;
  if (r.isServer) $('#impDir').value = r.dir;
}
$('#impBrowse').onclick = () => impBrowse($('#impDir').value.trim() || '');
$('#impUp').onclick = () => { const p = state.impCur?.parent; if (p !== null && p !== undefined) impBrowse(p); };
$('#impPick').onclick = () => { $('#impDir').value = state.impCur.dir; $('#impBrowser').hidden = true; impScan(); };
document.addEventListener('click', (e) => { const b = e.target.closest('[data-impdir]'); if (b) impBrowse(b.dataset.impdir); });
async function impScan() {
  const dir = $('#impDir').value.trim();
  if (!dir) return toast(t('err.import_no_dir'), true);
  const box = $('#impResult');
  box.hidden = false; box.innerHTML = `<p class="muted-p">${esc(t('imp.scanning'))}</p>`;
  let r;
  try { r = await api('/import/scan', { body: { dir } }); } catch (e) { box.innerHTML = `<div class="callout callout--warn"><svg class="i"><use href="#i-alert"/></svg><div class="callout-body">${esc(e.message)}</div></div>`; return; }
  state.impFound = r;
  const s = r.settings;
  const rows = [
    [t('imp.r.dir'), `<code>${esc(r.dir)}</code>`],
    [t('imp.r.system'), esc(osName(r.platform))],
    [t('imp.r.framework'), esc(FW_LABEL[r.framework] || r.framework)],
    [t('imp.r.script'), r.script ? `<code>${esc(r.script.name)}</code>` : `<span class="muted">${esc(t('imp.r.none'))}</span>`],
    [t('cfg.hostname'), esc(s.hostname || '—')],
    [t('imp.r.ports'), esc(`${s.port || 28015} / RCON ${s.rconPort || 28016}`)],
    [t('imp.r.map'), esc([s.level || 'Procedural Map', s.worldsize, s.seed ? '#' + s.seed : ''].filter(Boolean).join(' · '))],
    [t('imp.r.state'), r.running ? `<span class="tag tag--ok">${esc(t('imp.r.running', { n: r.running.players ?? 0 }))}</span>` : esc(t('imp.r.stopped'))],
  ];
  const warn = (r.warnings || []).map(w => `<li>${t('imp.w.' + w)}</li>`).join('');
  const ids = r.identities.length > 1 ? `<label class="field"><span>${esc(t('imp.identity'))}</span><select id="impId">${r.identities.map(i => `<option${i === r.identity ? ' selected' : ''}>${esc(i)}</option>`).join('')}</select></label>` : '';
  box.innerHTML = `
    <div class="imp-found">
      <h4>${esc(t('imp.found'))}</h4>
      <dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      ${warn ? `<ul class="imp-warn">${warn}</ul>` : ''}
      ${ids}
      ${!r.hasRconPassword ? `<label class="field"><span>${esc(t('imp.rconPass'))}</span><input id="impPass" type="password" autocomplete="off"><small class="field-hint">${esc(t('imp.rconPassHint'))}</small></label>` : ''}
      ${r.extraArgs ? `<label class="check"><input type="checkbox" id="impExtra" checked> <span>${esc(t('imp.keepExtra'))}</span> <code>${esc(r.extraArgs.slice(0, 120))}</code></label>` : ''}
      <div class="savebar savebar--inline"><button type="button" class="btn btn-primary" id="impApply">${esc(t('imp.apply'))}</button></div>
      <p class="field-hint">${esc(t('imp.safe'))}</p>
    </div>`;
  $('#impApply').onclick = impApply;
}
$('#impScan').onclick = impScan;
$('#impDir').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); impScan(); } };
async function impApply() {
  const r = state.impFound; if (!r) return;
  if (!await confirmDialog({ title: t('imp.apply'), body: esc(t('imp.confirm', { dir: r.dir })), confirm: t('imp.apply') })) return;
  const body = { dir: r.dir, identity: $('#impId')?.value, rconPassword: $('#impPass')?.value, keepExtra: $('#impExtra') ? $('#impExtra').checked : true };
  const res = await act(() => api('/import/apply', { body }), t('imp.done'));
  if (res && res !== true) {
    state.config = await api('/config');
    await refreshStatus();
    toast(t(res.running ? 'imp.doneRunning' : 'imp.doneStopped'));
    state.insMode = 'new'; renderInsMode(); renderInstallState();
  }
}


// ======================================================================
// Baneos compartidos (Centralized Banning de Rust)
// ======================================================================
const bl = { data: null };
async function loadBans() {
  try { bl.data = await api('/banlist'); } catch (e) { toast(e.message, true); return; }
  renderBans();
  api('/players').then(l => { $('#blPlayers').innerHTML = (l || []).map(p => `<option value="${esc(p.SteamID)}">${esc(p.DisplayName)}</option>`).join(''); }).catch(() => {});
}
function renderBans() {
  const d = bl.data;
  const f = $('#blForm').elements;
  f.enabled.checked = d.enabled; f.applyLocal.checked = d.applyLocal; f.shareMutes.checked = d.shareMutes;
  f.failureMode.value = String(d.failureMode); f.publicUrl.value = d.publicUrl || '';
  const st = !d.enabled ? [t('bl.st.off'), ''] : d.applied.ok ? [t('bl.st.on'), ' tag--ok'] : d.applyLocal ? [t('bl.st.pending'), ' tag--busy'] : [t('bl.st.shared'), ' tag--ok'];
  $('#blState').textContent = st[0]; $('#blState').className = 'tag' + st[1];
  const err = d.enabled && d.applyLocal && d.applied.error;
  $('#blApplyErr').hidden = !err;
  if (err) $('#blApplyErr').innerHTML = `<svg class="i"><use href="#i-alert"/></svg><div>${esc(t('err.' + d.applied.error))}</div>`;
  renderBanTable();
  // Claves: una por servidor o por amigo que use la lista
  $('#blKeys').innerHTML = d.keys.map(k => `<li>
    <div class="bl-key-main"><b>${esc(k.local ? t('bl.keyLocal') : k.name)}</b><small><code>${esc(k.hint)}</code> · ${esc(k.lastUsed ? t('bl.keyUsed', { when: fmtDate(k.lastUsed), n: fmtNum(k.hits) }) : t('bl.keyNever'))}</small></div>
    <button class="btn btn-sm" data-bl-copy="${esc(k.id)}"><svg class="i"><use href="#i-copy"/></svg>${esc(t('bl.keyCopy'))}</button>
    <button class="btn btn-sm btn-quiet" data-bl-rotate="${esc(k.id)}" title="${esc(t('bl.keyRotateHint'))}"><svg class="i"><use href="#i-rotate"/></svg>${esc(t('bl.keyRotate'))}</button>
    ${k.local ? '' : `<button class="btn btn-sm btn-quiet btn-icon" data-bl-revoke="${esc(k.id)}" data-name="${esc(k.name)}" title="${esc(t('bl.keyRevoke'))}" aria-label="${esc(t('bl.keyRevoke'))}"><svg class="i"><use href="#i-trash"/></svg></button>`}
  </li>`).join('');
  bl.sources = d.sources.map(x => ({ ...x }));
  renderSources();
  applyPerms($('[data-section="bans"]'));
}
function renderBanTable() {
  const q = ($('#blSearch').value || '').trim().toLowerCase();
  const all = bl.data.entries;
  const list = q ? all.filter(e => (e.steamId + ' ' + (e.name || '') + ' ' + (e.reason || '')).toLowerCase().includes(q)) : all;
  $('#blCount').textContent = fmtNum(all.length);
  $('#blTable tbody').innerHTML = list.length ? list.map(e => {
    const left = e.expiry ? (e.expiry - Date.now()) / 1000 : null;
    const ends = e.expiry ? `<b>${esc(fmtDur(left))}</b><small>${esc(fmtDate(e.expiry))}</small>` : `<b>${esc(t('bl.permanent'))}</b>`;
    const type = e.isMute ? `<span class="tag">${esc(t('bl.typeMute'))}</span> ` : '';
    return `<tr><td class="who"><b>${esc(e.name || e.steamId)}</b><small><code>${esc(e.steamId)}</code></small></td>
      <td>${type}${esc(e.reason || '—')}</td>
      <td>${esc(t('bl.src.' + e.source))}${e.by ? `<small>${esc(e.by)}</small>` : ''}</td>
      <td>${ends}</td>
      <td class="row-actions" data-perm="players.ban">${e.source === 'mute' ? '' : `<button class="btn btn-sm btn-quiet btn-icon" data-bl-del="${esc(e.steamId)}" data-name="${esc(e.name || e.steamId)}" data-source="${esc(e.source)}" title="${esc(t('bl.remove'))}" aria-label="${esc(t('bl.remove'))}"><svg class="i"><use href="#i-trash"/></svg></button>`}</td></tr>`;
  }).join('') : `<tr class="empty"><td colspan="5"><b>${esc(t('bl.empty'))}</b>${esc(t('bl.emptySub'))}</td></tr>`;
  applyPerms($('#blTable'));
}
$('#blSearch').oninput = () => renderBanTable();
function renderSources() {
  $('#blSrcRows').innerHTML = bl.sources.length ? bl.sources.map((x, i) => `<div class="bl-src" data-i="${i}">
    <input name="name" maxlength="40" value="${esc(x.name || '')}" placeholder="${esc(t('bl.srcName'))}" aria-label="${esc(t('bl.srcName'))}">
    <input name="url" spellcheck="false" value="${esc(x.url || '')}" placeholder="https://…/rustbans/" aria-label="URL">
    <select name="mode" aria-label="${esc(t('bl.srcMode'))}"><option value="alert"${x.mode !== 'block' ? ' selected' : ''}>${esc(t('bl.srcAlert'))}</option><option value="block"${x.mode === 'block' ? ' selected' : ''}>${esc(t('bl.srcBlock'))}</option></select>
    <label class="switch"><input type="checkbox" name="enabled"${x.enabled !== false ? ' checked' : ''}><span class="switch-ui"></span><span>${esc(t('bl.srcOn'))}</span></label>
    <button type="button" class="btn btn-sm" data-bl-test="${i}">${esc(t('bl.srcTest'))}</button>
    <button type="button" class="btn btn-sm btn-quiet btn-icon" data-bl-src-del="${i}" aria-label="${esc(t('bl.remove'))}"><svg class="i"><use href="#i-trash"/></svg></button>
  </div>`).join('') : `<p class="muted-p">${esc(t('bl.srcEmpty'))}</p>`;
}
function readSources() {
  return [...$('#blSrcRows').querySelectorAll('.bl-src')].map(r => ({
    id: bl.sources[+r.dataset.i]?.id, name: r.querySelector('[name=name]').value.trim(), url: r.querySelector('[name=url]').value.trim(),
    mode: r.querySelector('[name=mode]').value, enabled: r.querySelector('[name=enabled]').checked,
  }));
}
$('#blSrcAdd').onclick = () => { bl.sources = [...readSources(), { name: '', url: '', mode: 'alert', enabled: true }]; renderSources(); };
$('#blSrcRows').onclick = async (e) => {
  const del = e.target.closest('[data-bl-src-del]'), test = e.target.closest('[data-bl-test]');
  if (del) { const l = readSources(); l.splice(+del.dataset.blSrcDel, 1); bl.sources = l; renderSources(); }
  if (test) {
    const url = readSources()[+test.dataset.blTest].url;
    test.disabled = true;
    const r = await act(() => api('/banlist/sources/test', { body: { url } }));
    test.disabled = false;
    if (r && r !== true) toast(t('bl.srcTestOk', { ms: r.ms }));
  }
};
$('#blSources').onsubmit = async (e) => {
  e.preventDefault();
  const r = await act(() => api('/banlist/sources', { method: 'PUT', body: { sources: readSources() } }), t('bl.saved'));
  if (r && r !== true) loadBans();
};
$('#blForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const r = await act(() => api('/banlist', { method: 'PUT', body: { enabled: f.enabled.checked, applyLocal: f.applyLocal.checked, shareMutes: f.shareMutes.checked, failureMode: f.failureMode.value, publicUrl: f.publicUrl.value.trim() } }), t('bl.saved'));
  if (r && r !== true) loadBans();
};
$('#blAdd').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { steamId: f.steamId.value.trim(), name: f.name.value.trim(), reason: f.reason.value.trim(), minutes: f.minutes.value, isMute: !!f.isMute.value };
  const r = await act(() => api('/banlist/bans', { body }), t('bl.added'));
  if (r && r !== true) { e.target.reset(); f.minutes.value = '0'; loadBans(); }
};
$('#blCheck').onsubmit = async (e) => {
  e.preventDefault();
  const id = e.target.elements.steamId.value.trim(), box = $('#blCheckOut');
  const r = await act(() => api('/banlist/check/' + encodeURIComponent(id)));
  if (!r || r === true) return;
  const lines = [];
  if (r.local) lines.push(`<b>${esc(r.local.isMute ? t('bl.chkMuted') : t('bl.chkBanned'))}</b> ${esc(t('bl.src.' + r.local.source))}: ${esc(r.local.reason || '—')}`);
  for (const x of r.external) lines.push(`<b>${esc(x.source)}</b> (${esc(x.mode === 'block' ? t('bl.srcBlock') : t('bl.srcAlert'))}): ${esc(x.reason || '—')}`);
  const bad = lines.length > 0;
  box.className = 'callout ' + (bad ? 'callout--warn' : 'callout--ok');
  box.innerHTML = `<svg class="i"><use href="#i-${bad ? 'alert' : 'check'}"/></svg><div>${bad ? lines.join('<br>') : esc(t('bl.chkClean'))}</div>`;
  box.hidden = false;
};
$('#blTable').onclick = async (e) => {
  const b = e.target.closest('[data-bl-del]'); if (!b) return;
  const body = b.dataset.source === 'server' ? t('bl.removeServerBody', { name: b.dataset.name }) : t('bl.removeBody', { name: b.dataset.name });
  if (!await confirmDialog({ title: t('bl.remove'), body: esc(body), confirm: t('bl.remove'), danger: true })) return;
  const r = await act(() => api('/banlist/bans/' + b.dataset.blDel, { method: 'DELETE' }), t('bl.removed'));
  if (r) loadBans();
};
async function showKey(r) {
  const cmd = r.command;
  try { await navigator.clipboard.writeText(cmd); } catch {}
  await openDialog({
    title: t('bl.keyDlgTitle'),
    body: `<p>${esc(r.needsPublicUrl ? t('bl.keyDlgNeedUrl') : t('bl.keyDlgBody'))}</p><pre class="bl-cmd">${esc(cmd)}</pre><p class="field-hint">${esc(t('bl.keyDlgSecret'))}</p>`,
    actions: [{ label: t('common.close'), value: true, cls: 'btn-primary' }],
  });
}
$('#blKeys').onclick = async (e) => {
  const c = e.target.closest('[data-bl-copy]'), rot = e.target.closest('[data-bl-rotate]'), rev = e.target.closest('[data-bl-revoke]');
  if (c) { const r = await act(() => api(`/banlist/keys/${c.dataset.blCopy}/reveal`, { body: {} })); if (r && r !== true) showKey(r); }
  if (rot) {
    if (!await confirmDialog({ title: t('bl.keyRotate'), body: esc(t('bl.keyRotateBody')), confirm: t('bl.keyRotate'), danger: true })) return;
    const r = await act(() => api(`/banlist/keys/${rot.dataset.blRotate}/rotate`, { body: {} })); if (r && r !== true) { showKey(r); loadBans(); }
  }
  if (rev) {
    if (!await confirmDialog({ title: t('bl.keyRevoke'), body: esc(t('bl.keyRevokeBody', { name: rev.dataset.name })), confirm: t('bl.keyRevoke'), danger: true })) return;
    if (await act(() => api(`/banlist/keys/${rev.dataset.blRevoke}`, { method: 'DELETE' }), t('bl.keyRevoked'))) loadBans();
  }
};
$('#blKeyAdd').onsubmit = async (e) => {
  e.preventDefault();
  const r = await act(() => api('/banlist/keys', { body: { name: e.target.elements.name.value.trim() } }));
  if (r && r !== true) { e.target.reset(); await loadBans(); const k = await act(() => api(`/banlist/keys/${r.id}/reveal`, { body: {} })); if (k && k !== true) showKey(k); }
};

// --- Modo remoto ---
async function loadRemote() {
  let r; try { r = await api('/remote'); } catch { return; }
  state.remote = r;
  const f = $('#remoteForm').elements;
  f.host.value = r.host || ''; f.rconPort.value = r.rconPort || 28016; f.rconPassword.value = '';
  f.rconPassword.placeholder = r.hasPassword ? '••••••••' : '';
  $('#remPassHint').textContent = t(r.hasPassword ? 'rem.passSaved' : 'rem.passHint');
  $('#remState').textContent = t(r.enabled ? (state.status.rcon ? 'rem.st.on' : 'rem.st.waiting') : 'rem.st.off');
  $('#remState').className = 'tag' + (r.enabled && state.status.rcon ? ' tag--ok' : r.enabled ? ' tag--busy' : '');
  $('#remOff').hidden = !r.enabled;
  applyPerms($('#insRemote'));
  loadFiles();
}
const remBody = () => { const f = $('#remoteForm').elements; return { host: f.host.value.trim(), rconPort: f.rconPort.value, rconPassword: f.rconPassword.value }; };
$('#remTest').onclick = async () => {
  const r = await act(() => api('/remote/test', { body: remBody() }));
  if (r && r !== true) toast(t('rem.testOk', { name: r.hostname || '?', n: r.players ?? 0, max: r.maxPlayers ?? '?' }));
};
$('#remoteForm').onsubmit = async (e) => {
  e.preventDefault();
  const b = remBody();
  if (!state.remote?.enabled && !await confirmDialog({ title: t('rem.connect'), body: esc(t('rem.confirm', { host: b.host })), confirm: t('rem.connect') })) return;
  const r = await act(() => api('/remote', { method: 'PUT', body: b }), t('rem.saved'));
  if (r && r !== true) { state.config = await api('/config'); setTimeout(async () => { await refreshStatus(); loadRemote(); }, 2500); loadRemote(); }
};
$('#remOff').onclick = async () => {
  if (!await confirmDialog({ title: t('rem.disable'), body: esc(t('rem.disableBody')), confirm: t('rem.disable') })) return;
  const r = await act(() => api('/remote/disable', { body: {} }), t('rem.disabled'));
  if (r && r !== true) { state.config = await api('/config'); await refreshStatus(); state.insMode = 'new'; renderInsMode(); }
};

// --- Acceso a archivos por FTP/SFTP en modo remoto ---
async function loadFiles() {
  let v; try { v = await api('/remote/files'); } catch { return; }
  const f = $('#filesForm').elements;
  f.protocol.value = v.protocol || 'off'; f.host.value = v.host || ''; f.port.value = v.port || '';
  f.user.value = v.user || ''; f.root.value = v.root || '/'; f.password.value = '';
  f.password.placeholder = v.hasPassword ? '••••••••' : '';
  f.host.placeholder = state.remote?.host || '';
  $('#rfPassHint').textContent = v.hasPassword ? t('rem.passSaved') : '';
  const on = v.protocol && v.protocol !== 'off';
  $('#rfState').textContent = t(on ? 'rf.st.on' : 'rf.st.off');
  $('#rfState').className = 'tag' + (on ? ' tag--ok' : '');
  renderFilesProto();
  applyPerms($('#filesForm'));
}
function renderFilesProto() { $('#filesForm .rf-fields').hidden = $('#filesForm').elements.protocol.value === 'off'; $('#rfTest').hidden = $('#filesForm').elements.protocol.value === 'off'; }
$('#filesForm').elements.protocol.onchange = () => { renderFilesProto(); $('#rfResult').hidden = true; };
const filesBody = () => { const f = $('#filesForm').elements; return { protocol: f.protocol.value, host: f.host.value.trim(), port: f.port.value, user: f.user.value.trim(), password: f.password.value, root: f.root.value.trim() || '/' }; };
$('#rfTest').onclick = async () => {
  const box = $('#rfResult');
  const r = await act(() => api('/remote/files/test', { body: filesBody() }));
  if (!r || r === true) return;
  const fd = r.found || {};
  const bits = [fd.exe && t('rf.f.exe'), fd.server && t('rf.f.server'), fd.oxide && 'Oxide', fd.carbon && 'Carbon'].filter(Boolean);
  const good = fd.exe || fd.server;
  box.className = 'callout ' + (good ? 'callout--ok' : 'callout--warn');
  box.innerHTML = `<svg class="i"><use href="#i-${good ? 'check' : 'alert'}"/></svg><div>${esc(good ? t('rf.testOk') : t('rf.testOdd'))}${bits.length ? ' <b>' + esc(bits.join(' · ')) + '</b>' : ''}<br><small class="muted">${esc(r.entries.map(e => e.name + (e.dir ? '/' : '')).join('  '))}</small></div>`;
  box.hidden = false;
};
$('#filesForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await act(() => api('/remote/files', { method: 'PUT', body: filesBody() }), t('rf.saved'));
  if (r && r !== true) { await refreshStatus(); loadFiles(); }
};

// --- Lo que cambia en el resto del panel según el modo ---
const REMOTE_NOTES = { plugins: 'block', backups: 'block', wipes: 'note', schedule: 'note', config: 'note', perf: 'note' };
function applyMode() {
  const s = state.status || {};
  const remote = s.mode === 'remote';
  for (const [sec, kind] of Object.entries(REMOTE_NOTES)) {
    const el = $(`[data-section="${sec}"]`); if (!el) continue;
    let note = el.querySelector(':scope > .remote-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'callout callout--info remote-note';
      note.innerHTML = `<svg class="i"><use href="#i-globe"/></svg><div class="callout-body"></div>`;
      el.prepend(note);
    }
    // Con FTP/SFTP configurado los complementos sí se gestionan desde aquí
    const viaFiles = sec === 'plugins' && s.remoteFiles;
    note.hidden = !remote;
    note.querySelector('.callout-body').innerHTML = t(viaFiles ? 'rem.note.pluginsFiles' : 'rem.note.' + sec);
    el.classList.toggle('is-remote-blocked', remote && kind === 'block' && !viaFiles);
  }
  const wf = $('#wipeForm'); if (wf) wf.classList.toggle('is-remote-off', remote);
  $('[data-act=start]').hidden = remote;
  $('.op--danger').hidden = remote || (s.status !== 'stopped' && !s.managed);
}
// Complemento en modo remoto: no se puede instalar desde aquí, se descarga y se sube por FTP
function bridgeManualDialog() {
  return openDialog({
    title: t('rem.bridgeTitle'), body: `<p>${t('rem.bridgeText')}</p><ol class="bug-steps">${t('rem.bridgeSteps')}</ol>`,
    actions: [cancelAct(), { label: t('rem.bridgeDl'), cls: 'btn-primary', value: 'dl' }],
  }).then(v => { if (v === 'dl') location.href = '/api/bridge/file'; });
}

// ======================================================================
// Web pública (ajustes y vista previa)
// ======================================================================
const pb = { data: null };
const pubUrl = () => `${location.origin}/server`;
async function loadPublic() {
  try { pb.data = await api('/public'); } catch (e) { toast(e.message, true); return; }
  renderPublic();
}
function renderPublic() {
  const s = pb.data, f = $('#pubForm').elements;
  f.enabled.checked = s.enabled; f.address.value = s.address; f.lang.value = s.lang;
  f.tagline.value = s.tagline; f.description.value = s.description; f.rules.value = (s.rules || []).join('\n');
  for (const k of ['discord', 'store', 'website', 'steam']) f[k].value = s.links[k] || '';
  for (const k of ['showMap', 'showChart', 'showRankings', 'showPlayers']) f[k].checked = !!s[k];
  f.accent.value = s.accent || '#5BB5A2';
  $('#pbState').textContent = t(s.enabled ? 'pb.on' : 'pb.off');
  $('#pbState').className = 'tag' + (s.enabled ? ' tag--ok' : '');
  $('#pbUrl').hidden = !s.enabled;
  $('#pbUrlText').textContent = pubUrl();
  $('#pbOpen').href = pubUrl();
  $('#pbOff').hidden = s.enabled;
  const fr = $('#pbFrame');
  if (s.enabled) fr.src = pubUrl() + '?preview=' + Date.now(); else fr.removeAttribute('src');
  applyPerms($('[data-section="public"]'));
}
$('#pubForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    enabled: f.enabled.checked, address: f.address.value.trim(), lang: f.lang.value, tagline: f.tagline.value, description: f.description.value,
    rules: f.rules.value, accent: f.accent.value,
    links: { discord: f.discord.value.trim(), store: f.store.value.trim(), website: f.website.value.trim(), steam: f.steam.value.trim() },
  };
  for (const k of ['showMap', 'showChart', 'showRankings', 'showPlayers']) body[k] = f[k].checked;
  const r = await act(() => api('/public', { method: 'PUT', body }), t('pb.saved'));
  if (r) { pb.data = r; renderPublic(); }
};
$('#pbCopy').onclick = async () => { try { await navigator.clipboard.writeText(pubUrl()); toast(t('pb.copied')); } catch { toast(pubUrl()); } };

// ======================================================================
// Planificador de wipes
// ======================================================================
const wp = { data: null, timer: null };
async function loadWipes() {
  const sel = $('#wpWeekday');
  if (!sel.options.length) sel.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}">${esc(new Date(2024, 0, 7 + d).toLocaleDateString(locale(), { weekday: 'long' }))}</option>`).join('');
  try { wp.data = await api('/wipes'); } catch (e) { toast(e.message, true); return; }
  renderWipes();
  clearInterval(wp.timer);
  wp.timer = setInterval(() => { if (state.view !== 'wipes') return clearInterval(wp.timer); renderCountdown(); }, 1000);
}
const wDate = (tt) => new Date(tt).toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function heroTarget() {
  const d = wp.data;
  if (d.settings.enabled && d.upcoming[0]) return { ...d.upcoming[0], planned: true };
  return d.forced[0] ? { at: d.forced[0], forced: true, planned: false } : null;
}
function renderCountdown() {
  const w = heroTarget(), el = $('#wpCount');
  if (!w) { el.innerHTML = ''; return; }
  let s = Math.max(0, Math.floor((w.at - Date.now()) / 1000));
  const parts = [[Math.floor(s / 86400), t('wp.u.d')], [Math.floor(s % 86400 / 3600), t('wp.u.h')], [Math.floor(s % 3600 / 60), t('wp.u.m')], [s % 60, t('wp.u.s')]];
  el.innerHTML = parts.map(([n, u]) => `<div><b>${String(n).padStart(2, '0')}</b><small>${esc(u)}</small></div>`).join('');
  el.setAttribute('aria-label', t('wp.countLabel', { d: fmtDur(s) }));
}
function renderWipes() {
  const d = wp.data, s = d.settings, w = heroTarget();
  $('#wpHero').classList.toggle('is-off', !s.enabled);
  $('#wpKicker').textContent = !s.enabled ? t('wp.offKicker') : w?.forced ? t('wp.kForced') : t('wp.kCustom');
  $('#wpWhen').textContent = w ? wDate(w.at) : '—';
  $('#wpTags').innerHTML = !w ? '' : !s.enabled
    ? `<span class="wp-tag">${esc(t('wp.offTag'))}</span>`
    : [w.forced ? `<span class="wp-tag wp-tag--forced">${esc(t('wp.tagForced'))}</span>` : '', `<span class="wp-tag">${esc(t('wp.tagMap'))}</span>`, w.bp ? `<span class="wp-tag wp-tag--bp">${esc(t('wp.tagBp'))}</span>` : '', s.update && w.forced ? `<span class="wp-tag">${esc(t('wp.tagUpdate'))}</span>` : ''].join('');
  renderCountdown();
  const f = $('#wipeForm').elements;
  f.enabled.checked = s.enabled;
  for (const r of f.schedule) r.checked = r.value === s.schedule;
  f.weekday.value = String(s.weekday); f.time.value = s.time; f.bp.value = s.bp; f.forcedDelay.value = s.forcedDelay;
  for (const k of ['newSeed', 'backup', 'update', 'announce', 'discord']) f[k].checked = !!s[k];
  $('#wpDayTime').hidden = s.schedule === 'forced';
  $('#wpTz').textContent = t('wp.tz', { tz: d.tz });
  const list = s.enabled ? d.upcoming : d.forced.map(at => ({ at, forced: true, bp: s.bp !== 'never', key: null }));
  $('#wpList').innerHTML = list.length ? list.map(x => `<li>
      <div class="wp-date"><b>${esc(wDate(x.at))}</b><small>${esc(t(x.forced ? 'wp.kForced' : 'wp.kCustom'))} · ${esc(t('wp.inX', { d: fmtDur((x.at - Date.now()) / 1000) }))}</small></div>
      ${x.bp ? `<span class="wp-tag wp-tag--bp">${esc(t('wp.tagBp'))}</span>` : ''}
      ${x.key && can('wipe') ? `<button type="button" class="btn btn-sm btn-quiet" data-skip="${esc(x.key)}">${esc(t('wp.skip'))}</button>` : ''}
    </li>`).join('') : `<li class="wp-empty">${esc(t('wp.none'))}</li>`;
  $('#wpHist tbody').innerHTML = d.history.length ? d.history.map(h => `<tr>
      <td>${esc(new Date(h.t).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
      <td>${esc(t(h.manual ? 'wp.h.manual' : h.forced ? 'wp.kForced' : 'wp.kCustom'))}</td>
      <td>${esc(t(h.bp ? 'common.yes' : 'common.no'))}</td>
      <td><code>${esc(h.seed ?? '—')}</code></td>
      <td>${h.ok ? `<span class="tag tag--ok">${esc(t('wp.h.ok'))}</span>` : `<span class="tag tag--err" title="${esc(h.error || '')}">${esc(t('wp.h.fail'))}</span>`}</td></tr>`).join('') : `<tr><td colspan="5" class="empty">${esc(t('wp.h.none'))}</td></tr>`;
  applyPerms($('[data-section="wipes"]'));
}
$('#wipeForm').addEventListener('change', (e) => { if (e.target.name === 'schedule') $('#wpDayTime').hidden = e.target.value === 'forced'; });
$('#wipeForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements, body = { enabled: f.enabled.checked, schedule: [...f.schedule].find(r => r.checked)?.value, weekday: +f.weekday.value, time: f.time.value, bp: f.bp.value, forcedDelay: +f.forcedDelay.value };
  for (const k of ['newSeed', 'backup', 'update', 'announce', 'discord']) body[k] = f[k].checked;
  const r = await act(() => api('/wipes', { method: 'PUT', body }), t('wp.saved'));
  if (r) { wp.data = r; renderWipes(); refreshStatus(); }
};
$('#wpList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-skip]'); if (!b) return;
  if (!await confirmDialog({ title: t('wp.skipTitle'), body: esc(t('wp.skipBody')), confirm: t('wp.skip') })) return;
  const r = await act(() => api('/wipes/skip', { body: { key: b.dataset.skip } }), t('wp.skipped'));
  if (r) { wp.data = r; renderWipes(); refreshStatus(); }
});

// ======================================================================
// Rates, modo PvP/PvE y mundo (hora, clima, eventos)
// ======================================================================
const RATE_KEYS = ['gather', 'pickup', 'quarry', 'craft'];
const rt = { data: null, world: null };
const fmtX = (n) => `${String(n).replace('.', LANG === 'en' ? '.' : ',')}x`;

async function loadRates() {
  try { rt.data = await api('/rates'); } catch (e) { toast(e.message, true); return; }
  renderMode(); renderRates();
  loadWorld();
}
function renderMode() {
  const d = rt.data; if (!d) return;
  const mode = d.pve ? 'pve' : 'pvp';
  $('#modeCard').dataset.mode = mode;
  $$('.mode-opt').forEach(b => {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-checked', String(on));
    b.disabled = !can('server.config');
  });
  $('#modeLive').textContent = d.online ? t('rt.liveOn') : t('rt.liveOff');
}
function renderRates() {
  const d = rt.data, r = d.rates, f = $('#ratesForm').elements;
  for (const k of RATE_KEYS) { f[k].value = r[k]; $('#o_' + k).textContent = fmtX(r[k]); }
  f.decayScale.value = r.decayScale; f.crateSeconds.value = r.crateSeconds;
  for (const k of ['upkeep', 'radiation', 'stability', 'announce']) f[k].checked = !!r[k];
  markPreset();
  const needFw = d.framework === 'none', bi = d.bridgeInfo || {};
  const btn = (key) => can('watch.settings') ? ` <button type="button" class="btn btn-sm btn-primary" id="rtInstallBridge">${esc(t(key))}</button>` : '';
  let msg = '';
  if (needFw) msg = `${esc(t('rt.needFw'))} <button type="button" class="link" data-goto="install">${esc(t('rt.goInstall'))}</button>`;
  else if (bi.error) msg = `${esc(t('rt.bridgeErr'))}<code class="bridge-err">${esc(bi.error.line)}</code>${btn('rt.reinstallBridge')}`;
  else if (!d.bridge && !bi.installed) msg = esc(t('rt.bridgeNotInstalled')) + btn('rt.installBridge');
  else if (!d.bridge && !d.online) msg = esc(t('rt.bridgeOffline'));
  else if (!d.bridge) msg = esc(t('rt.needBridge')) + btn('rt.reinstallBridge');
  else if (bi.outdated) msg = esc(t('rt.bridgeOutdated', { v: bi.version, b: bi.bundled })) + btn('rt.updateBridge');
  $('#rtNeedFw').hidden = !msg;
  $('#rtNeedFw').classList.toggle('callout--info', !!(d.bridge && bi.outdated));
  $('#rtNeedFwText').innerHTML = msg;
  if ($('#rtInstallBridge')) $('#rtInstallBridge').onclick = async (e) => {
    if (isRemoteMode()) return bridgeManualDialog();
    e.currentTarget.disabled = true;
    if (await act(() => api('/watch/bridge', { body: {} }), t('rt.bridgeInstalling'))) {
      setTimeout(loadRates, 8000); setTimeout(loadRates, 17000);
    } else e.currentTarget.disabled = false;
  };
  const b = $('#rtBridge');
  b.textContent = needFw ? t('rt.badgeFw') : d.bridge ? (bi.version ? `${t('rt.badgeOk')} · v${bi.version}` : t('rt.badgeOk')) : t('rt.badgeBridge');
  b.className = 'rt-badge' + (d.bridge ? ' rt-badge--ok' : '');
  $('#ratesState').textContent = d.online ? '' : t('rt.applyLater');
  applyPerms($('[data-section="rates"]'));
}
function markPreset() {
  const f = $('#ratesForm').elements, vals = RATE_KEYS.map(k => +f[k].value);
  $$('.preset').forEach(p => p.setAttribute('aria-pressed', String(vals.every(v => v === +p.dataset.preset))));
}
$('#ratesForm').addEventListener('input', (e) => {
  if (RATE_KEYS.includes(e.target.name)) { $('#o_' + e.target.name).textContent = fmtX(+e.target.value); markPreset(); }
});
$$('.preset').forEach(p => p.onclick = () => {
  const f = $('#ratesForm').elements, n = +p.dataset.preset;
  for (const k of RATE_KEYS) { f[k].value = n; $('#o_' + k).textContent = fmtX(n); }
  markPreset();
});
$('#ratesForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements, body = {};
  for (const k of RATE_KEYS) body[k] = +f[k].value;
  body.decayScale = +f.decayScale.value; body.crateSeconds = +f.crateSeconds.value;
  for (const k of ['upkeep', 'radiation', 'stability', 'announce']) body[k] = f[k].checked;
  const r = await act(() => api('/rates', { method: 'PUT', body }));
  if (!r) return;
  rt.data = r; renderRates();
  const a = r.applied || {};
  toast(!r.online ? t('rt.savedLater') : (a.multipliers || r.framework === 'none' ? t('rt.savedLive') : t('rt.savedNoBridge')));
  refreshStatus();
};
$$('.mode-opt').forEach(b => b.onclick = async () => {
  const pve = b.dataset.mode === 'pve';
  if (!rt.data || rt.data.pve === pve) return;
  if (!await confirmDialog({ title: t(pve ? 'rt.toPve' : 'rt.toPvp'), body: esc(t(pve ? 'rt.toPveBody' : 'rt.toPvpBody')), confirm: t(pve ? 'rt.toPve' : 'rt.toPvp'), danger: !pve })) return;
  b.classList.add('is-busy');
  const r = await act(() => api('/rates/mode', { method: 'PUT', body: { pve } }), t(pve ? 'rt.nowPve' : 'rt.nowPvp'));
  b.classList.remove('is-busy');
  if (r) { rt.data = r; renderMode(); refreshStatus(); }
});

async function loadWorld() {
  try { rt.world = await api('/world'); } catch { rt.world = { online: false }; }
  renderWorld();
}
function renderWorld() {
  const w = rt.world || {}, ok = can('server.control');
  const hh = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;
  $('#wdClock').textContent = !w.online ? t('wd.offline') : (w.hour != null ? t(w.frozen ? 'wd.clockFrozen' : 'wd.clock', { h: hh(w.hour) }) : '');
  $$('#worldPanel [data-time], #worldPanel [data-weather]').forEach(b => { b.disabled = !w.online || !ok; });
  $$('#worldPanel [data-event]').forEach(b => { b.disabled = !w.online || !w.bridge || !ok; });
  $('#wdFreeze').disabled = !w.online || !ok;
  $('#wdFreeze').checked = !!w.frozen;
  $('#wdEvHint').textContent = !w.online ? '' : w.bridge ? t('wd.evHint') : t('wd.evNeedBridge');
}
async function worldAct(btn, path, body, okMsg) {
  btn.classList.add('is-busy');
  const r = await act(() => api(path, { body }), okMsg);
  btn.classList.remove('is-busy');
  if (r) { btn.classList.add('is-done'); setTimeout(() => btn.classList.remove('is-done'), 1500); }
  return r;
}
$$('#worldPanel [data-time]').forEach(b => b.onclick = async () => {
  const r = await worldAct(b, '/world/time', { preset: b.dataset.time }, t('wd.timeSet', { t: t('wd.t.' + b.dataset.time) }));
  if (r) { rt.world = r; renderWorld(); }
});
$('#wdFreeze').onchange = async (e) => {
  const r = await act(() => api('/world/time', { body: { freeze: e.target.checked } }), t(e.target.checked ? 'wd.frozenOk' : 'wd.unfrozenOk'));
  if (r) { rt.world = r; renderWorld(); } else e.target.checked = !e.target.checked;
};
$$('#worldPanel [data-weather]').forEach(b => b.onclick = () => worldAct(b, '/world/weather', { preset: b.dataset.weather }, t('wd.weatherSet', { w: t('wd.w.' + b.dataset.weather) })));
$$('#worldPanel [data-event]').forEach(b => b.onclick = () => worldAct(b, '/world/event', { type: b.dataset.event }, t('wd.eventSet', { e: t('wd.e.' + b.dataset.event) })));

// ======================================================================
// Wiki
// ======================================================================
function renderWiki() {
  const q = $('#wikiSearch').value.trim().toLowerCase();
  const strip = (h) => h.replace(/<[^>]+>/g, ' ');
  const secs = WIKI.filter(s => !q || s.title.toLowerCase().includes(q) || strip(s.html).toLowerCase().includes(q));
  $('#wikiToc').innerHTML = secs.map(s => `<a href="#wiki-${esc(s.id)}" data-wiki="${esc(s.id)}">${esc(s.title)}</a>`).join('') || `<p class="small">${esc(t('wiki.noResults'))}</p>`;
  $('#wikiBody').innerHTML = secs.map(s => `
    <section class="wiki-sec" id="wiki-${esc(s.id)}">
      <h2>${esc(s.title)}</h2>
      ${s.html}
      ${s.goto ? `<p class="wiki-go"><button class="btn btn-sm" data-goto="${esc(s.goto)}">${esc(t('wiki.open', { section: t('nav.' + s.goto) }))}${ic('arrow')}</button></p>` : ''}
    </section>`).join('') || `<p class="text-2">${esc(t('wiki.noResultsLong', { q }))}</p>`;
  if (q) {
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    $$('#wikiBody p:not(.wiki-go), #wikiBody li, #wikiBody td').forEach(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(n => { if (re.test(n.nodeValue)) { const span = document.createElement('span'); span.innerHTML = esc(n.nodeValue).replace(re, '<mark>$1</mark>'); n.replaceWith(span); } re.lastIndex = 0; });
    });
  }
}
$('#wikiSearch').oninput = renderWiki;
$('#wikiToc').addEventListener('click', (e) => {
  const a = e.target.closest('[data-wiki]'); if (!a) return;
  e.preventDefault();
  $('#wiki-' + a.dataset.wiki)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  $$('#wikiToc a').forEach(x => x.toggleAttribute('aria-current', x === a));
});

// ======================================================================
// Equipos (dentro de Jugadores)
// ======================================================================
async function loadTeams(refresh = false) {
  const box = $('#teamsBody');
  try {
    const d = refresh ? await api('/teams/refresh', { body: {} }) : await api('/teams');
    $('#teamsCount').textContent = d.teams.length || '';
    $('#teamsInfo').textContent = d.limit ? t('team.limitInfo', { n: d.limit }) : t('team.noLimit');
    if (!d.t) { box.innerHTML = `<p class="teams-empty">${esc(t('team.noData'))}</p>`; return; }
    const member = (m) => `<li><span class="dot ${m.online ? 'on' : ''}" title="${esc(t(m.online ? 'team.online' : 'team.offline'))}"></span>${esc(m.name)}${can('inventory.view') ? ` <button class="link small" data-inv="${esc(m.steamid)}" data-name="${esc(m.name)}">${esc(t('inv.button'))}</button>` : ''}</li>`;
    const teams = d.teams.map(tm => `
      <div class="team ${tm.over ? 'team--over' : ''}">
        <div class="team-head"><b>${esc(t('team.team', { n: tm.members.length }))}</b>${tm.over ? `<span class="sev sev--high">${esc(t('team.over', { n: d.limit }))}</span>` : ''}</div>
        <ul>${tm.members.map(member).join('')}</ul>
      </div>`).join('');
    const groups = d.groups.map(g => `
      <div class="team team--group ${g.over ? 'team--over' : ''}">
        <div class="team-head"><b>${esc(t('team.group', { n: g.members.length }))}</b><span class="small">${esc(tn('team.tcs', g.cupboards))}</span>${g.over ? `<span class="sev sev--medium">${esc(t('team.over', { n: d.limit }))}</span>` : ''}</div>
        <ul>${g.members.map(m => member({ ...m, online: false })).join('')}</ul>
      </div>`).join('');
    box.innerHTML = (teams || `<p class="teams-empty">${esc(t('team.none'))}</p>`) +
      (groups ? `<h4 class="teams-sub">${esc(t('team.groupsTitle'))}</h4><p class="small">${esc(t('team.groupsSub'))}</p>${groups}` : '') +
      `<p class="small teams-time">${esc(t('team.updated', { d: timeAgo(d.t) }))}</p>`;
  } catch (e) { box.innerHTML = `<p class="teams-empty">${esc(e.message)}</p>`; }
}
$('#teamsRefresh').onclick = () => loadTeams(true);

// ======================================================================
// VPN, proxy y país (ajustes en Vigilancia)
// ======================================================================
async function loadIpSettings() {
  if (!can('watch.settings')) { $('#ipForm').hidden = true; return; }
  try {
    const st = await api('/ipcheck');
    const f = $('#ipForm');
    $$('.modeSel', f).forEach(sel => { sel.innerHTML = ['off', 'alert', 'kick'].map(m => `<option value="${m}">${esc(t('steam.mode.' + m))}</option>`).join(''); });
    for (const el of f.elements) {
      if (!el.name || !(el.name in st)) continue;
      if (el.type === 'checkbox') el.checked = !!st[el.name];
      else if (el.name === 'whitelist') el.value = (st.whitelist || []).join('\n');
      else if (el.name === 'countries') el.value = (st.countries || []).join(', ');
      else if (el.name !== 'apiKey') el.value = st[el.name];
    }
    f.elements.apiKey.value = '';
    f.elements.apiKey.placeholder = st.hasKey ? st.keyHint : 'xxxxxx-xxxxxx-xxxxxx-xxxxxx';
    $('#ipKeyState').textContent = t(st.hasKey ? 'ipc.keySaved' : 'ipc.keyMissing');
    $('#ipClearKey').hidden = !st.hasKey;
    renderIpProvider();
  } catch (e) { toast(e.message, true); }
}
function renderIpProvider() {
  const p = $('#ipForm').elements.provider.value;
  $('#ipKeyWrap').hidden = $('#ipKeyStateWrap').hidden = p !== 'proxycheck';
  $('#ipProvHint').innerHTML = t('ipc.hint.' + p);
}
$('#ipForm').elements.provider.onchange = renderIpProvider;
$('#ipForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (!body.apiKey) delete body.apiKey;
  if (await act(() => api('/ipcheck', { method: 'PUT', body }), t('ipc.saved'))) loadIpSettings();
};
$('#ipClearKey').onclick = async () => {
  if (await act(() => api('/ipcheck', { method: 'PUT', body: { clearKey: true } }), t('steam.keyCleared'))) loadIpSettings();
};
$('#ipTest').onclick = async () => {
  const ip = $('#ipTestIp').value.trim();
  if (!ip) return;
  const r = await act(() => api('/ipcheck/test', { body: { ip } })); if (!r || r === true) return;
  const x = r.result, yes = (b) => esc(t(b ? 'common.yes' : 'common.no'));
  const rows = x.private ? `<p>${esc(t('ipc.private'))}</p>` : `<dl class="facts">
    <dt>VPN / Proxy</dt><dd>${yes(x.vpn || x.proxy)}</dd><dt>Tor</dt><dd>${yes(x.tor)}</dd>
    <dt>${esc(t('ipc.datacenter'))}</dt><dd>${yes(x.hosting)}</dd><dt>${esc(t('ipc.country'))}</dt><dd>${esc(x.country || '—')}</dd>
    <dt>${esc(t('ipc.isp'))}</dt><dd>${esc(x.provider || '—')}</dd></dl>`;
  const fl = r.findings.length ? `<ul class="alerts" style="border:1px solid var(--line-soft);border-radius:6px;margin-top:12px">${r.findings.map(f => `<li class="alert" data-sev="${f.severity}"><div class="alert-top"><span class="sev sev--${f.severity}">${esc(t('sev.' + f.severity))}</span><span class="alert-title">${esc(t(`alert.${f.code}.title`, f.params))}</span><span class="alert-time">${esc(t('steam.mode.' + f.mode))}</span></div></li>`).join('')}</ul>` : `<p>${esc(t('ipc.clean'))}</p>`;
  openDialog({ title: ip, body: rows + fl, actions: [{ label: t('common.close'), cls: 'btn-quiet', value: null }] });
};

// ======================================================================
// Perfiles de Steam (ajustes en Vigilancia)
// ======================================================================
async function loadSteamSettings() {
  loadIpSettings();
  if (!can('watch.settings')) { $('#steamForm').hidden = true; return; }
  try {
    const st = await api('/steam/settings');
    state.steamSettings = st;
    const f = $('#steamForm');
    $$('.modeSel', f).forEach(sel => { sel.innerHTML = ['off', 'alert', 'kick'].map(m => `<option value="${m}">${esc(t('steam.mode.' + m))}</option>`).join(''); });
    for (const el of f.elements) {
      if (!el.name || !(el.name in st)) continue;
      if (el.type === 'checkbox') el.checked = !!st[el.name];
      else if (el.name === 'whitelist') el.value = (st.whitelist || []).join('\n');
      else if (el.name !== 'apiKey') el.value = st[el.name];
    }
    f.elements.apiKey.value = '';
    f.elements.apiKey.placeholder = st.hasKey ? st.keyHint : 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    $('#steamKeyState').textContent = t(st.hasKey ? 'steam.keySaved' : 'steam.keyMissing');
    $('#steamClearKey').hidden = !st.hasKey;
  } catch (e) { toast(e.message, true); }
}
$('#steamForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (!body.apiKey) delete body.apiKey;
  if (await act(() => api('/steam/settings', { method: 'PUT', body }), t('steam.saved'))) loadSteamSettings();
};
$('#steamClearKey').onclick = async () => {
  if (!await confirmDialog({ title: t('steam.clearKey'), body: esc(t('steam.clearKeyBody')), confirm: t('steam.clearKey'), danger: true })) return;
  if (await act(() => api('/steam/settings', { method: 'PUT', body: { clearKey: true } }), t('steam.keyCleared'))) loadSteamSettings();
};
$('#steamTest').onclick = async () => {
  const id = $('#steamTestId').value.trim();
  if (!/^\d{17}$/.test(id)) { toast(t('err.bad_steamid'), true); return; }
  const r = await act(() => api('/steam/check/' + id, { body: {} }));
  if (!r || r === true) return;
  invHistId = id;
  openDialog({
    title: r.profile.name || id, wide: true,
    body: `<div class="steam-box" id="steamBox">${steamBlock(r.profile)}</div>
      ${r.findings.length ? `<ul class="alerts" style="border:1px solid var(--line-soft);border-radius:6px">${r.findings.map(f => `<li class="alert" data-sev="${f.severity}"><div class="alert-top"><span class="sev sev--${f.severity}">${esc(t('sev.' + f.severity))}</span><span class="alert-title">${esc(t(`alert.${f.code}.title`, f.params))}</span><span class="alert-time">${esc(t('steam.mode.' + f.mode))}</span></div><p class="alert-detail">${esc(t(`alert.${f.code}.detail`, { ...f.params, action: '' }))}</p></li>`).join('')}</ul>` : `<p>${esc(t('steam.clean'))}</p>`}`,
    actions: [{ label: t('common.close'), cls: 'btn-quiet', value: null }],
  });
};

// ======================================================================
// Administradores y registro de actividad
// ======================================================================
const ROLES = ['owner', 'admin', 'moderator', 'viewer'];
function roleOptions(sel) { return ROLES.map(r => `<option value="${r}" ${r === sel ? 'selected' : ''}>${esc(t('role.' + r))}</option>`).join(''); }

async function loadAdmins() {
  if (can('users')) {
    $$('.roleSel').forEach(s => { s.innerHTML = roleOptions('moderator'); });
    $('#roleHelp').textContent = t('role.help.moderator');
    const tb = $('#usersTbl tbody');
    try {
      const list = await api('/users');
      $('#usersCount').textContent = list.length;
      tb.innerHTML = list.map(u => {
        const self = u.id === state.me.id;
        return `<tr>
          <td class="who"><b>${esc(u.username)}</b>${self ? ` <span class="sev">${esc(t('adm.you'))}</span>` : ''}<span class="sub">${esc(t('adm.since', { d: fmtDate(u.created) }))}</span></td>
          <td>${self ? esc(t('role.' + u.role)) : `<select data-urole="${u.id}" aria-label="${esc(t('adm.role'))}">${roleOptions(u.role)}</select>`}</td>
          <td>${u.twoFactor ? `<span class="state state--on">${esc(t('tfa.onShort'))}</span>` : `<span class="state">${esc(t('tfa.offShort'))}</span>`}</td>
          <td class="text-2">${u.lastLogin ? esc(timeAgo(u.lastLogin)) : '—'}</td>
          <td>${self ? '' : `${u.twoFactor ? `<button class="btn btn-sm btn-quiet" data-u2fa="${u.id}" data-name="${esc(u.username)}">${esc(t('tfa.reset'))}</button>` : ''}<button class="btn btn-sm btn-quiet" data-upw=""${u.id}" data-name="${esc(u.username)}">${esc(t('adm.resetPw'))}</button><button class="btn btn-sm btn-quiet btn-icon" data-udel="${u.id}" data-name="${esc(u.username)}" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}">${ic('trash')}</button>`}</td>
        </tr>`;
      }).join('');
    } catch (e) { tb.innerHTML = emptyRow(5, t('common.loadError'), e.message); }
  }
  if (can('audit')) loadAudit();
}
$('#userForm').elements.role.onchange = (e) => { $('#roleHelp').textContent = t('role.help.' + e.target.value); };
$('#userForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const r = await act(() => api('/users', { body: { username: f.username.value.trim(), password: f.password.value, role: f.role.value } }), t('adm.created', { name: f.username.value.trim() }));
  if (r) { e.target.reset(); loadAdmins(); }
};
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-urole]'); if (!sel) return;
  if (await act(() => api('/users/' + sel.dataset.urole, { method: 'PUT', body: { role: sel.value } }), t('adm.roleChanged'))) loadAdmins();
});
document.addEventListener('click', async (e) => {
  const pw = e.target.closest('[data-upw]');
  if (pw) {
    const v = await openDialog({
      title: t('adm.resetPwTitle', { name: pw.dataset.name }),
      body: `<label class="field"><span>${esc(t('acc.new'))}</span><input id="dlgInput" type="password" autocomplete="new-password"></label><p class="small">${esc(t('adm.resetPwNote'))}</p>`,
      actions: [cancelAct(), { label: t('adm.resetPw'), cls: 'btn-primary', get: () => $('#dlgInput').value, validate: () => ($('#dlgInput').value.length < 8 ? t('err.password_short') : null) }],
    });
    if (v) act(() => api('/users/' + pw.dataset.upw, { method: 'PUT', body: { password: v } }), t('adm.pwReset'));
  }
  const r2 = e.target.closest('[data-u2fa]');
  if (r2 && await confirmDialog({ title: t('tfa.resetTitle', { name: r2.dataset.name }), body: esc(t('tfa.resetBody')), confirm: t('tfa.reset'), danger: true })) {
    if (await act(() => api('/users/' + r2.dataset.u2fa, { method: 'PUT', body: { reset2fa: true } }), t('tfa.resetDone'))) loadAdmins();
  }
  const del = e.target.closest('[data-udel]');
  if (del && await confirmDialog({ title: t('adm.deleteTitle', { name: del.dataset.name }), body: esc(t('adm.deleteBody')), confirm: t('common.delete'), danger: true })) {
    if (await act(() => api('/users/' + del.dataset.udel, { method: 'DELETE' }), t('adm.deleted'))) loadAdmins();
  }
});

async function loadAudit() {
  const tb = $('#auditTbl tbody');
  const user = $('#auditUser').value;
  try {
    const list = await api('/audit?limit=300' + (user ? '&user=' + encodeURIComponent(user) : ''));
    if (!user) {
      const names = [...new Set(list.map(x => x.user))].sort();
      $('#auditUser').innerHTML = `<option value="">${esc(t('audit.allUsers'))}</option>` + names.map(n => `<option>${esc(n)}</option>`).join('');
    }
    tb.innerHTML = list.length ? list.map(x => {
      const det = Object.entries(x.details || {}).filter(([k]) => !['steamid'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ');
      const label = STR['audit.a.' + x.action] || BASE['audit.a.' + x.action] ? t('audit.a.' + x.action) : x.action;
      return `<tr>
        <td class="nowrap text-2" title="${esc(fmtDate(x.t))}">${esc(timeAgo(x.t))}</td>
        <td><b>${esc(x.user)}</b></td>
        <td>${esc(label)}${x.target ? ` <code>${esc(x.target)}</code>` : ''}</td>
        <td class="audit-det">${esc(det)}</td>
        <td>${x.denied ? `<span class="sev sev--high">${esc(t('audit.denied'))}</span>` : x.ok ? `<span class="state state--on">${esc(t('audit.ok'))}</span>` : `<span class="sev sev--medium">${esc(t('audit.failed'))}</span>`}</td>
      </tr>`;
    }).join('') : emptyRow(5, t('audit.empty'), '');
  } catch (e) { tb.innerHTML = emptyRow(5, t('common.loadError'), e.message); }
}
$('#auditUser').onchange = loadAudit;
$('#auditRefresh').onclick = loadAudit;

// ======================================================================
// Mapa en vivo
// ======================================================================
const mapS = { meta: null, img: null, zoom: 1, x: 0, y: 0, pos: null, timer: null, sel: null, focus: null, drag: null };
// Geometría de la imagen que genera MapImageRenderer de Rust: el mundo ocupa el centro y alrededor
// hay un margen de océano de N PÍXELES (500 por defecto, no metros). Por eso el área del mundo en la
// imagen mide (ancho - 2·margen) píxeles, y no sirve suponer un margen en metros.
function mapGeom() {
  const m = mapS.meta;
  let mx = m.oceanMargin ?? 500, my = m.oceanMargin ?? 500;
  // Por si la imagen viene sin margen o con otro tamaño: se deduce de la escala por defecto (0,5 px/m)
  if (m.width - 2 * mx <= 0) mx = Math.max(0, (m.width - m.worldSize * (m.scale || 0.5)) / 2);
  if (m.height - 2 * my <= 0) my = Math.max(0, (m.height - m.worldSize * (m.scale || 0.5)) / 2);
  return { mx, my, w: m.width - 2 * mx, h: m.height - 2 * my, half: m.worldSize / 2, ws: m.worldSize };
}
function worldToImg(wx, wz) {
  const g = mapGeom();
  return [g.mx + (wx + g.half) / g.ws * g.w, g.my + (g.half - wz) / g.ws * g.h];
}
function imgToWorld(px, py) {
  const g = mapGeom();
  return [(px - g.mx) / g.w * g.ws - g.half, g.half - (py - g.my) / g.h * g.ws];
}
// Cuadrícula de Rust: celdas de ~146 m, columnas con letras y filas desde 0 arriba
function gridInfo() {
  const ws = mapS.meta.worldSize, cells = Math.floor(ws / 146.3), size = ws / cells;
  return { cells, size };
}
function colName(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
function gridRef(wx, wz) {
  const { cells, size } = gridInfo(), half = mapS.meta.worldSize / 2;
  const c = Math.floor((wx + half) / size), r = Math.floor((half - wz) / size);
  if (c < 0 || r < 0 || c >= cells || r >= cells) return '';
  return colName(c) + r;
}
const toScreen = (px, py) => [px * mapS.zoom + mapS.x, py * mapS.zoom + mapS.y];

async function mapStart() {
  $('#mapCard').hidden = true;
  if (!mapS.meta) await mapLoadMeta();
  else { mapApply(); }
  mapPoll();
  clearInterval(mapS.timer);
  mapS.timer = setInterval(mapPoll, 3000);
}
function mapStop() { clearInterval(mapS.timer); mapS.timer = null; }

async function mapLoadMeta(refresh = false) {
  const empty = $('#mapEmpty');
  empty.hidden = false;
  empty.innerHTML = `<p>${esc(t(refresh ? 'map.rendering' : 'map.loading'))}</p>`;
  try {
    const m = refresh ? await api('/map/refresh', { body: {} }) : await api('/map');
    if (!m) throw new Error(t('err.map_not_ready'));
    mapS.meta = m;
    const img = $('#mapImg');
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(t('err.map_not_ready'))); img.src = '/api/map/image?v=' + m.renderedAt; });
    empty.hidden = true;
    mapDrawPaths();
    mapFit();
    $('#mapStatus').textContent = m.stale ? t('map.stale') : '';
  } catch (e) {
    mapS.meta = null;
    empty.innerHTML = `<p><b>${esc(t('map.unavailable'))}</b>${esc(e.message)}</p>${/ScrapwardenBridge/.test(e.message) ? `<button class="btn btn-sm" data-goto="watch">${esc(t('inv.goWatch'))}</button>` : ''}`;
  }
}

function mapFit() {
  if (!mapS.meta) return;
  const st = $('#mapStage').getBoundingClientRect();
  mapS.zoom = Math.min(st.width / mapS.meta.width, st.height / mapS.meta.height);
  mapS.x = (st.width - mapS.meta.width * mapS.zoom) / 2;
  mapS.y = (st.height - mapS.meta.height * mapS.zoom) / 2;
  mapApply();
}

// Rutas del mapa (como en el juego): se dibujan una vez en coordenadas de la imagen dentro de la capa
// que ya se mueve y escala con el mapa; el grosor de línea se mantiene fijo en pantalla.
// PATH_STYLE, MON_SVG, MON_RULES y monIcon están en mapshared.js
function mapDrawPaths() {
  const svg = $('#mapPaths'), m = mapS.meta;
  svg.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
  svg.setAttribute('width', m.width); svg.setAttribute('height', m.height);
  const P = m.paths;
  $('#mkPathsHint').hidden = !!P;
  ['#mlRoads', '#mlRails', '#mlRivers', '#mlPower'].forEach(id => { $(id).disabled = !P; $(id).closest('label').title = P ? '' : t('map.key.pathsUpdate'); });
  if (!P) { svg.innerHTML = ''; return; }
  let out = '';
  for (const layer of ['rivers', 'roads', 'rails', 'power']) {
    const d = (P[layer] || []).map(seg => {
      let s = '';
      for (let i = 0; i < seg.length; i += 2) { const [x, y] = worldToImg(seg[i], seg[i + 1]); s += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }
      return s;
    }).join('');
    if (!d) continue;
    out += `<g data-layer="${layer}">` + PATH_STYLE[layer].map(([c, w, dash, o]) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-opacity="${o}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`).join('') + '</g>';
  }
  svg.innerHTML = out;
  mapPathsVisibility();
}
function mapPathsVisibility() {
  const on = { roads: $('#mlRoads').checked, rails: $('#mlRails').checked, rivers: $('#mlRivers').checked, power: $('#mlPower').checked };
  $$('#mapPaths g[data-layer]').forEach(g => { g.style.display = on[g.dataset.layer] ? '' : 'none'; });
}

$('#mkMonIcon').innerHTML = `<i class="mon-ic">${monIcon({ name: 'Launch Site' })}</i>`;

function mapApply() {
  if (!mapS.meta) return;
  $('#mapLayer').style.transform = `translate(${mapS.x}px, ${mapS.y}px) scale(${mapS.zoom})`;
  $('#mapLayer').style.width = mapS.meta.width + 'px';
  mapDrawGrid();
  mapDrawMarkers();
}

function mapDrawGrid() {
  const svg = $('#mapGrid');
  if (!$('#mlGrid').checked || !mapS.meta) { svg.innerHTML = ''; return; }
  const { cells, size } = gridInfo(), half = mapS.meta.worldSize / 2;
  const showLabels = size * mapS.zoom * (mapGeom().w / mapS.meta.worldSize) > 26;
  let out = '';
  for (let i = 0; i <= cells; i++) {
    const [x1, y1] = toScreen(...worldToImg(-half + i * size, half));
    const [x2, y2] = toScreen(...worldToImg(-half + i * size, -half));
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    const [a1, b1] = toScreen(...worldToImg(-half, half - i * size));
    const [a2, b2] = toScreen(...worldToImg(half, half - i * size));
    out += `<line x1="${a1}" y1="${b1}" x2="${a2}" y2="${b2}"/>`;
  }
  if (showLabels) {
    for (let c = 0; c < cells; c++) for (let r = 0; r < cells; r++) {
      const [x, y] = toScreen(...worldToImg(-half + c * size, half - r * size));
      out += `<text x="${x + 3}" y="${y + 11}">${colName(c)}${r}</text>`;
    }
  }
  svg.innerHTML = out;
}

const teamColor = (id) => {
  if (!id || id === '0') return 'var(--text)';
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 62%)`;
};
const EVENT_ICON = { cargo: 'CS', heli: 'HE', bradley: 'BR', chinook: 'CH' };

function mapDrawMarkers() {
  const box = $('#mapMarkers');
  if (!mapS.meta) { box.innerHTML = ''; return; }
  const P = mapS.pos || { players: [], sleepers: [], events: [] };
  const names = $('#mlNames').checked;
  let out = '';
  if ($('#mlMonuments').checked) {
    for (const m of mapS.meta.monuments || []) {
      const [x, y] = toScreen(...worldToImg(m.x, m.z));
      out += `<span class="mk-mon" style="left:${x}px;top:${y}px"><i class="mon-ic">${monIcon(m)}</i><span>${esc(m.name)}</span></span>`;
    }
  }
  if ($('#mlEvents').checked) {
    for (const ev of P.events || []) {
      const [x, y] = toScreen(...worldToImg(ev.x, ev.z));
      out += `<span class="mk-ev mk-ev--${ev.kind}" style="left:${x}px;top:${y}px" title="${esc(t('map.ev.' + ev.kind))}">${EVENT_ICON[ev.kind] || '?'}</span>`;
    }
  }
  const pl = (p, sleeper) => {
    const [x, y] = toScreen(...worldToImg(p.x, p.z));
    const sel = mapS.sel === p.steamid;
    return `<button class="mk-pl ${sleeper ? 'is-sleeper' : ''} ${p.dead ? 'is-dead' : ''} ${sel ? 'is-sel' : ''}" style="left:${x}px;top:${y}px;--c:${sleeper ? 'var(--muted)' : teamColor(p.team)}" data-mpl="${esc(p.steamid)}" aria-label="${esc(p.name)}"><i></i>${names || sel ? `<span>${esc(p.name)}</span>` : ''}</button>`;
  };
  if ($('#mlSleepers').checked) for (const p of P.sleepers || []) out += pl(p, true);
  for (const p of P.players || []) out += pl(p, false);
  box.innerHTML = out;
  renderMapKey(P);
}

// Leyenda: recuentos en vivo y equipos que hay ahora mismo en el mapa
function renderMapKey(P) {
  const players = P.players || [], sleepers = P.sleepers || [], events = P.events || [];
  const alive = players.filter(p => !p.dead);
  const noTeam = alive.filter(p => !p.team || p.team === '0').length;
  $('#mkNoTeam').textContent = noTeam;
  $('#mkTeamed').textContent = alive.length - noTeam;
  $('#mkDead').textContent = players.filter(p => p.dead).length;
  $('#mkSleep').textContent = sleepers.length;
  $('#mkSleepHint').hidden = $('#mlSleepers').checked;
  for (const k of ['cargo', 'heli', 'bradley', 'chinook']) $('#mkEv_' + k).textContent = events.filter(e => e.kind === k).length;
  const teams = {};
  for (const p of players) if (p.team && p.team !== '0') (teams[p.team] ||= []).push(p.name);
  const list = Object.entries(teams).sort((a, b) => b[1].length - a[1].length);
  $('#mkTeams').innerHTML = list.length
    ? `<h5>${esc(t('map.key.teamsNow'))}</h5>` + list.slice(0, 12).map(([id, names]) => `<button type="button" class="mk-team" data-mkteam="${esc(id)}" title="${esc(names.join(', '))}"><i class="kdot" style="--c:${teamColor(id)}"></i><span>${esc(names.slice(0, 2).join(', '))}${names.length > 2 ? ` +${names.length - 2}` : ''}</span><b>${names.length}</b></button>`).join('')
      + (list.length > 12 ? `<p class="mk-hint">${esc(t('map.key.moreTeams', { n: list.length - 12 }))}</p>` : '')
    : `<p class="mk-hint">${esc(t('map.key.noTeams'))}</p>`;
}
// Al pulsar un equipo de la leyenda se centra el mapa en su primer miembro
$('#mkTeams').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mkteam]'); if (!b || !mapS.pos) return;
  const p = (mapS.pos.players || []).find(x => x.team === b.dataset.mkteam);
  if (p) { mapCenterOn(p.steamid); mapS.sel = p.steamid; mapDrawMarkers(); mapShowCard(p.steamid, false); }
});
$('#mlSleepers').addEventListener('change', () => { $('#mkSleepHint').hidden = $('#mlSleepers').checked; });

async function mapPoll() {
  if (state.view !== 'map' || !mapS.meta) return;
  try {
    mapS.pos = await api('/map/positions');
    $('#mapPlayers').innerHTML = [...mapS.pos.players, ...mapS.pos.sleepers].map(p => `<option value="${esc(p.name)}">`).join('');
    if (mapS.focus) { mapCenterOn(mapS.focus); mapS.focus = null; }
    mapDrawMarkers();
    if (mapS.sel) mapShowCard(mapS.sel, false);
  } catch (e) { $('#mapStatus').textContent = e.message; }
}

function mapFind(id) {
  const P = mapS.pos || {};
  const p = (P.players || []).find(x => x.steamid === id);
  if (p) return { p, sleeper: false };
  const s = (P.sleepers || []).find(x => x.steamid === id);
  return s ? { p: s, sleeper: true } : null;
}

function mapCenterOn(id) {
  const f = mapFind(id);
  if (!f) { toast(t('map.notFound'), true); return; }
  if (f.sleeper) $('#mlSleepers').checked = true;
  const st = $('#mapStage').getBoundingClientRect();
  mapS.zoom = Math.max(mapS.zoom, 1.2);
  const [px, py] = worldToImg(f.p.x, f.p.z);
  mapS.x = st.width / 2 - px * mapS.zoom;
  mapS.y = st.height / 2 - py * mapS.zoom;
  mapS.sel = id;
  mapApply();
  mapShowCard(id);
}

function mapShowCard(id, open = true) {
  const f = mapFind(id), card = $('#mapCard');
  if (!f) { card.hidden = true; return; }
  const p = f.p;
  const mates = p.team && p.team !== '0' ? (mapS.pos.players || []).concat(mapS.pos.sleepers || []).filter(x => x.team === p.team && x.steamid !== p.steamid) : [];
  card.innerHTML = `
    <div class="map-card-head"><b>${esc(p.name)}</b><button class="btn btn-quiet btn-icon btn-sm" id="mapCardClose" aria-label="${esc(t('common.close'))}">${ic('x')}</button></div>
    <dl class="facts">
      <dt>${esc(t('inv.state'))}</dt><dd>${esc(t(p.dead ? 'inv.dead' : f.sleeper ? 'inv.sleeping' : 'inv.online'))}</dd>
      <dt>${esc(t('pl.health'))}</dt><dd>${p.health}</dd>
      <dt>${esc(t('map.gridRef'))}</dt><dd>${esc(gridRef(p.x, p.z))}</dd>
      <dt>${esc(t('inv.position'))}</dt><dd>${Math.round(p.x)} ${Math.round(p.z)}</dd>
      <dt>${esc(t('map.team'))}</dt><dd>${mates.length ? esc(mates.map(m => m.name).join(', ')) : esc(t('map.noTeam'))}</dd>
    </dl>
    <div class="btn-group">
      ${can('inventory.view') ? `<button class="btn btn-sm" data-inv="${esc(p.steamid)}" data-name="${esc(p.name)}">${ic('backpack')}${esc(t('inv.button'))}</button>` : ''}
      ${can('watch.review') ? `<button class="btn btn-sm btn-quiet" data-hist="${esc(p.steamid)}">${ic('eye')}${esc(t('watch.history'))}</button>` : ''}
      ${can('players.kick') && !f.sleeper ? `<button class="btn btn-sm btn-quiet" data-quick="kick" data-id="${esc(p.steamid)}" data-name="${esc(p.name)}">${esc(t('pl.kick'))}</button>` : ''}
      ${can('players.ban') ? `<button class="btn btn-sm btn-danger-outline" data-quick="ban" data-id="${esc(p.steamid)}" data-name="${esc(p.name)}">${esc(t('pl.ban'))}</button>` : ''}
    </div>`;
  if (open) card.hidden = false;
  $('#mapCardClose').onclick = () => { card.hidden = true; mapS.sel = null; mapDrawMarkers(); };
}

// Interacción: arrastrar, rueda, clic en jugador, coordenadas al pasar el ratón
(() => {
  const stage = $('#mapStage');
  stage.addEventListener('wheel', (e) => {
    if (!mapS.meta) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    const old = mapS.zoom, min = Math.min(r.width / mapS.meta.width, r.height / mapS.meta.height) * 0.8;
    mapS.zoom = Math.min(8, Math.max(min, old * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
    mapS.x = cx - (cx - mapS.x) * (mapS.zoom / old);
    mapS.y = cy - (cy - mapS.y) * (mapS.zoom / old);
    mapApply();
  }, { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mk-pl, .map-card')) return;
    mapS.drag = { x: e.clientX, y: e.clientY, ox: mapS.x, oy: mapS.y, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    if (mapS.drag) {
      const dx = e.clientX - mapS.drag.x, dy = e.clientY - mapS.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) mapS.drag.moved = true;
      mapS.x = mapS.drag.ox + dx; mapS.y = mapS.drag.oy + dy;
      mapApply();
    }
    if (!mapS.meta) return;
    const [wx, wz] = imgToWorld((e.clientX - r.left - mapS.x) / mapS.zoom, (e.clientY - r.top - mapS.y) / mapS.zoom);
    const g = gridRef(wx, wz), hv = $('#mapHover');
    hv.hidden = !g;
    hv.textContent = g ? `${g}  ·  ${Math.round(wx)}, ${Math.round(wz)}` : '';
  });
  stage.addEventListener('pointerup', () => { mapS.drag = null; });
  stage.addEventListener('pointerleave', () => { $('#mapHover').hidden = true; });
  stage.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mpl]'); if (!b) return;
    mapS.sel = b.dataset.mpl; mapDrawMarkers(); mapShowCard(mapS.sel);
  });
  stage.addEventListener('keydown', (e) => {
    const step = 60;
    if (e.key === 'ArrowLeft') mapS.x += step; else if (e.key === 'ArrowRight') mapS.x -= step;
    else if (e.key === 'ArrowUp') mapS.y += step; else if (e.key === 'ArrowDown') mapS.y -= step;
    else if (e.key === '+' || e.key === '-') {
      const r = stage.getBoundingClientRect(), old = mapS.zoom;
      mapS.zoom = Math.min(8, Math.max(0.05, old * (e.key === '+' ? 1.2 : 1 / 1.2)));
      mapS.x = r.width / 2 - (r.width / 2 - mapS.x) * (mapS.zoom / old); mapS.y = r.height / 2 - (r.height / 2 - mapS.y) * (mapS.zoom / old);
    } else return;
    e.preventDefault(); mapApply();
  });
  window.addEventListener('resize', () => { if (state.view === 'map') mapApply(); });
})();
['#mlNames', '#mlSleepers', '#mlEvents', '#mlMonuments', '#mlGrid', '#mlRoads', '#mlRails', '#mlRivers', '#mlPower'].forEach(id => $(id).onchange = () => { store.set('rp_map' + id, $(id).checked ? '1' : '0'); mapPathsVisibility(); mapApply(); });
['#mlNames', '#mlSleepers', '#mlEvents', '#mlMonuments', '#mlGrid', '#mlRoads', '#mlRails', '#mlRivers', '#mlPower'].forEach(id => { const v = store.get('rp_map' + id); if (v !== null) $(id).checked = v === '1'; });
$('#mapFit').onclick = mapFit;
$('#mapRender').onclick = () => mapLoadMeta(true);
$('#mapSearch').addEventListener('change', () => {
  const q = $('#mapSearch').value.trim().toLowerCase(); if (!q || !mapS.pos) return;
  const all = [...mapS.pos.players, ...mapS.pos.sleepers];
  const p = all.find(x => x.name.toLowerCase() === q) || all.find(x => x.name.toLowerCase().includes(q) || x.steamid === q);
  if (p) mapCenterOn(p.steamid); else toast(t('map.notFound'), true);
});
// "Ver en el mapa" desde cualquier lista
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-locate]'); if (!b) return;
  if (!$('#dialog').hidden) closeDialog();
  mapS.focus = b.dataset.locate;
  go('map');
});

// ======================================================================
// Moderación: ficha del jugador, silencios, advertencias, notas, baneos temporales
// ======================================================================
state.modSummary = {};
async function loadModSummary() {
  try { const r = await api('/mod'); state.modSummary = r.summary; state.modActive = r.active; } catch {}
}
function modBadges(id) {
  const m = state.modSummary?.[id]; if (!m) return '';
  let out = '';
  if (m.warnings) out += ` <span class="mbadge mbadge--warn" title="${esc(tn('mod.warnCount', m.warnings))}">${ic('flag')}${m.warnings}</span>`;
  if (m.muted) out += ` <span class="mbadge" title="${esc(t('mod.muted'))}">${ic('mute')}</span>`;
  if (m.notes) out += ` <span class="mbadge" title="${esc(tn('mod.noteCount', m.notes))}">${ic('note')}${m.notes}</span>`;
  return out;
}
const fmtUntil = (u) => (u ? t('mod.until', { d: fmtDate(u), left: fmtDur((u - Date.now()) / 1000) }) : t('mod.indefinite'));

async function loadModBox() {
  const box = $('#modBox'); if (!box) return;
  const id = box.dataset.sid, name = box.dataset.name;
  try {
    const m = await api('/mod/' + id);
    const sanction = [];
    if (m.mute) sanction.push(`<div class="sanction">${ic('mute')}<span><b>${esc(t('mod.muted'))}</b> ${esc(fmtUntil(m.mute.until))}${m.mute.reason ? ` · ${esc(m.mute.reason)}` : ''}<small>${esc(t('mod.by', { by: m.mute.by === 'system' ? t('mod.system') : m.mute.by }))}</small></span><button class="btn btn-sm btn-quiet" data-unmute="${id}">${esc(t('mod.unmute'))}</button></div>`);
    if (m.tempban) sanction.push(`<div class="sanction sanction--ban">${ic('lock')}<span><b>${esc(t('mod.tempbanned'))}</b> ${esc(fmtUntil(m.tempban.until))}${m.tempban.reason ? ` · ${esc(m.tempban.reason)}` : ''}<small>${esc(t('mod.by', { by: m.tempban.by === 'system' ? t('mod.system') : m.tempban.by }))}</small></span>${can('players.ban') ? `<button class="btn btn-sm btn-quiet" data-quick="unban" data-id="${id}" data-name="${esc(name)}">${esc(t('pl.unban'))}</button>` : ''}</div>`);
    box.innerHTML = `
      <div class="mod-head"><b>${esc(t('mod.title'))}</b>
        <div class="btn-group">
          ${!m.mute ? `<button class="btn btn-sm" data-mute="${id}" data-name="${esc(name)}">${ic('mute')}${esc(t('mod.mute'))}</button>` : ''}
          <button class="btn btn-sm" data-warn="${id}" data-name="${esc(name)}">${ic('flag')}${esc(t('mod.warn'))}</button>
          ${can('players.ban') && !m.tempban ? `<button class="btn btn-sm btn-danger-outline" data-tempban="${id}" data-name="${esc(name)}">${ic('lock')}${esc(t('mod.tempban'))}</button>` : ''}
        </div></div>
      ${sanction.join('')}
      <div class="mod-cols">
        <div>
          <h5>${esc(t('mod.warnings'))} <span class="count">${m.activeWarnings}/${m.warnings.length}</span></h5>
          <ul class="mod-list">${m.warnings.map(w => `<li class="${w.active ? '' : 'is-old'}"><span>${esc(w.reason)}<small>${esc(fmtDate(w.t))} · ${esc(w.by === 'system' ? t('mod.system') : w.by)}${w.active ? '' : ' · ' + esc(t('mod.expired'))}</small></span><button class="btn btn-sm btn-quiet btn-icon" data-delwarn="${w.id}" aria-label="${esc(t('common.delete'))}">${ic('trash')}</button></li>`).join('') || `<li class="empty">${esc(t('mod.noWarnings'))}</li>`}</ul>
        </div>
        <div>
          <h5>${esc(t('mod.notes'))}</h5>
          <form class="input-row" id="noteForm"><input id="noteText" maxlength="1000" placeholder="${esc(t('mod.notePh'))}"><button class="btn btn-sm">${esc(t('mod.addNote'))}</button></form>
          <ul class="mod-list">${m.notes.map(n => `<li><span>${esc(n.text)}<small>${esc(fmtDate(n.t))} · ${esc(n.by)}</small></span><button class="btn btn-sm btn-quiet btn-icon" data-delnote="${n.id}" aria-label="${esc(t('common.delete'))}">${ic('trash')}</button></li>`).join('') || `<li class="empty">${esc(t('mod.noNotes'))}</li>`}</ul>
        </div>
      </div>`;
    $('#noteForm').onsubmit = async (e) => {
      e.preventDefault();
      const text = $('#noteText').value.trim(); if (!text) return;
      if (await act(() => api(`/mod/${id}/note`, { body: { text } }), t('mod.noteAdded'))) loadModBox();
    };
  } catch (e) { box.innerHTML = `<p class="small">${esc(e.message)}</p>`; }
}

// Diálogos de sanción reutilizables (ficha, chat, jugadores)
async function askMute(id, name) {
  const r = await openDialog({
    title: t('mod.muteTitle', { name: name || id }),
    body: `<div class="field-row"><label class="field"><span>${esc(t('mod.duration'))}</span><select id="dlgDur">${[5, 15, 60, 360, 1440, 0].map(mn => `<option value="${mn}" ${mn === 15 ? 'selected' : ''}>${esc(mn ? fmtDur(mn * 60) : t('mod.indefinite'))}</option>`).join('')}</select></label>
      <label class="field"><span>${esc(t('pl.reason'))} <em>${esc(t('common.optional'))}</em></span><input id="dlgInput"></label></div>`,
    actions: [cancelAct(), { label: t('mod.mute'), cls: 'btn-primary', get: () => ({ minutes: +$('#dlgDur').value, reason: $('#dlgInput').value }) }],
  });
  if (r) return act(() => api(`/mod/${id}/mute`, { body: { ...r, name } }), t('mod.mutedMsg', { name: name || id }));
}
async function askWarn(id, name) {
  const policy = state.modPolicy || await api('/mod/policy').catch(() => null);
  const reason = await openDialog({
    title: t('mod.warnTitle', { name: name || id }),
    body: `<label class="field"><span>${esc(t('mod.warnReason'))}</span><input id="dlgInput" maxlength="300" placeholder="${esc(t('mod.warnPh'))}"></label>
      ${policy?.steps?.length ? `<p class="small">${esc(t('mod.policyHint', { list: policy.steps.map(st => t('mod.stepShort', { n: st.at, action: { k: 'mod.sa.' + st.action }, d: st.minutes ? fmtDur(st.minutes * 60) : '' })).join('; ') }))}</p>` : ''}`,
    actions: [cancelAct(), { label: t('mod.warn'), cls: 'btn-primary', get: () => $('#dlgInput').value.trim(), validate: () => (!$('#dlgInput').value.trim() ? t('err.empty_reason') : null) }],
  });
  if (!reason) return;
  const r = await act(() => api(`/mod/${id}/warn`, { body: { reason, name } }));
  if (r && r !== true) toast(r.applied ? t('mod.warnedApplied', { n: r.active, action: { k: 'mod.sa.' + r.applied.action } }) : t('mod.warnedMsg', { n: r.active }));
  return r;
}
async function askTempban(id, name) {
  const r = await openDialog({
    title: t('mod.tempbanTitle', { name: name || id }),
    body: `<div class="field-row"><label class="field"><span>${esc(t('mod.duration'))}</span><select id="dlgDur">${[60, 360, 1440, 4320, 10080, 43200].map(mn => `<option value="${mn}" ${mn === 1440 ? 'selected' : ''}>${esc(fmtDur(mn * 60))}</option>`).join('')}</select></label>
      <label class="field"><span>${esc(t('pl.reasonLabel'))}</span><input id="dlgInput"></label></div><p class="small">${esc(t('mod.tempbanNote'))}</p>`,
    actions: [cancelAct(), { label: t('mod.tempban'), cls: 'btn-danger', get: () => ({ minutes: +$('#dlgDur').value, reason: $('#dlgInput').value }) }],
  });
  if (r) return act(() => api(`/mod/${id}/tempban`, { body: { ...r, name } }), t('mod.tempbannedMsg', { name: name || id }));
}
document.addEventListener('click', async (e) => {
  const el = (sel) => e.target.closest(sel);
  let b;
  const after = () => { loadModBox(); loadModSummary().then(() => { if (state.view === 'chat') renderSanctions(); if (state.view === 'players') loadPlayers(); }); };
  if ((b = el('[data-mute]'))) { if (await askMute(b.dataset.mute, b.dataset.name)) after(); }
  else if ((b = el('[data-unmute]'))) { if (await act(() => api(`/mod/${b.dataset.unmute}/unmute`, { body: {} }), t('mod.unmutedMsg'))) after(); }
  else if ((b = el('[data-warn]'))) { if (await askWarn(b.dataset.warn, b.dataset.name)) after(); }
  else if ((b = el('[data-tempban]'))) { if (await askTempban(b.dataset.tempban, b.dataset.name)) after(); }
  else if ((b = el('[data-delwarn]'))) { const id = $('#modBox').dataset.sid; if (await act(() => api(`/mod/${id}/warn/${b.dataset.delwarn}`, { method: 'DELETE' }), t('mod.warnDeleted'))) after(); }
  else if ((b = el('[data-delnote]'))) { const id = $('#modBox').dataset.sid; if (await act(() => api(`/mod/${id}/note/${b.dataset.delnote}`, { method: 'DELETE' }), t('mod.noteDeleted'))) after(); }
});

// ======================================================================
// Chat
// ======================================================================
const chatS = { items: [], player: null, timer: null, target: '' };

async function loadChat() {
  $('#chatInput').placeholder = t('chat.inputPh');
  state.chatOnline = await api('/players').catch(() => []);
  await loadModSummary();
  renderSanctions();
  loadFilterForms();
  await fetchChat();
}
async function fetchChat() {
  const ch = $('input[name=chch]:checked').value;
  const qs = new URLSearchParams({ limit: 300, ch, q: $('#chatSearch').value.trim() });
  if (chatS.player) qs.set('steamid', chatS.player.id);
  try { chatS.items = (await api('/chat?' + qs)).reverse(); renderChat(); } catch (e) { $('#chatFeed').innerHTML = `<p class="chat-empty">${esc(e.message)}</p>`; }
  updateTargets();
}
function highlight(msg, word) {
  const safe = esc(msg);
  if (!word) return safe;
  const base = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const i = base(msg).indexOf(base(word));
  return i < 0 ? safe : esc(msg.slice(0, i)) + `<mark>${esc(msg.slice(i, i + word.length))}</mark>` + esc(msg.slice(i + word.length));
}
function chatLine(m) {
  const chLabel = m.ch === 'pm' ? t('chat.pmTo', { name: m.toName || m.to }) : t(m.ch === 'team' ? 'chat.team' : 'chat.global');
  const who = m.id === 'panel'
    ? `<span class="cm-name cm-panel">${esc(m.name)}</span>`
    : `<span class="cm-who"><button class="cm-name" data-cm="${esc(m.id)}" data-name="${esc(m.name)}">${esc(m.name)}</button>${modBadges(m.id)}</span>`;
  return `<div class="cm ${m.word ? 'is-flagged' : ''} ${m.blocked ? 'is-blocked' : ''} cm--${m.ch}">
    <span class="cm-time" title="${esc(fmtDate(m.t))}">${fmtTime(m.t)}</span>
    <span class="cm-ch">${esc(chLabel)}</span>
    ${who}
    <span class="cm-msg">${highlight(m.msg, m.word)}${m.blocked ? ` <span class="cm-tag">${esc(t('chat.blocked'))}</span>` : ''}</span>
  </div>`;
}
function renderChat() {
  const feed = $('#chatFeed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.innerHTML = chatS.items.length ? chatS.items.map(chatLine).join('') : `<p class="chat-empty">${esc(t('chat.empty'))}</p>`;
  if (atBottom || !feed.dataset.init) { feed.scrollTop = feed.scrollHeight; feed.dataset.init = 1; }
}
function onChatMsg(m) {
  if (state.view !== 'chat') return;
  const ch = $('input[name=chch]:checked').value, q = $('#chatSearch').value.trim().toLowerCase();
  if (ch !== 'all' && !(ch === 'flagged' ? m.word : m.ch === ch)) return;
  if (chatS.player && m.id !== chatS.player.id && m.to !== chatS.player.id) return;
  if (q && !m.msg.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) return;
  chatS.items.push(m);
  if (chatS.items.length > 600) chatS.items.shift();
  const feed = $('#chatFeed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  if (feed.querySelector('.chat-empty')) feed.innerHTML = '';
  feed.insertAdjacentHTML('beforeend', chatLine(m));
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}
function updateTargets() {
  const sel = $('#chatTarget'); if (!sel) return;
  const online = (state.status.info ? state.chatOnline : null) || [];
  const cur = chatS.target;
  sel.innerHTML = `<option value="">${esc(t('chat.toAll'))}</option>` +
    (can('players.moderate') ? online.map(p => `<option value="${esc(p.SteamID)}">${esc(t('chat.toPlayer', { name: p.DisplayName }))}</option>`).join('') : '');
  sel.value = online.some(p => p.SteamID === cur) ? cur : '';
}
$('#chatTarget').onchange = (e) => { chatS.target = e.target.value; };
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#chatInput').value.trim(); if (!msg) return;
  const to = $('#chatTarget').value;
  const ok = to ? await act(() => api('/chat/pm', { body: { steamid: to, message: msg } })) : await act(() => api('/say', { body: { message: msg } }));
  if (ok) $('#chatInput').value = '';
};
$$('input[name=chch]').forEach(r => r.onchange = fetchChat);
let chatSearchT;
$('#chatSearch').oninput = () => { clearTimeout(chatSearchT); chatSearchT = setTimeout(fetchChat, 250); };
$('#chatPlayerClear').onclick = () => { chatS.player = null; $('#chatPlayerChip').hidden = true; fetchChat(); };

// Menú al hacer clic en un nombre del chat
document.addEventListener('click', (e) => {
  const menu = $('#chatMenu');
  const b = e.target.closest('[data-cm]');
  if (!b) { if (!e.target.closest('#chatMenu')) menu.hidden = true; return; }
  const id = b.dataset.cm, name = b.dataset.name;
  const items = [
    can('players.moderate') && `<button data-cmact="pm">${ic('send')}${esc(t('chat.reply'))}</button>`,
    `<button data-cmact="only">${ic('search')}${esc(t('chat.onlyPlayer'))}</button>`,
    can('players.moderate') && `<button data-mute="${esc(id)}" data-name="${esc(name)}">${ic('mute')}${esc(t('mod.mute'))}</button>`,
    can('players.moderate') && `<button data-warn="${esc(id)}" data-name="${esc(name)}">${ic('flag')}${esc(t('mod.warn'))}</button>`,
    can('watch.review') && `<button data-hist="${esc(id)}">${ic('note')}${esc(t('mod.file'))}</button>`,
    `<button data-locate="${esc(id)}">${ic('locate')}${esc(t('map.locate'))}</button>`,
    can('players.kick') && `<button data-quick="kick" data-id="${esc(id)}" data-name="${esc(name)}">${esc(t('pl.kick'))}</button>`,
  ].filter(Boolean).join('');
  menu.innerHTML = `<div class="chat-menu-head">${esc(name)}</div>${items}`;
  const r = b.getBoundingClientRect();
  menu.style.left = Math.min(window.innerWidth - 230, r.left) + 'px';
  menu.style.top = Math.min(window.innerHeight - 320, r.bottom + 4) + 'px';
  menu.hidden = false;
  menu.dataset.id = id; menu.dataset.name = name;
});
$('#chatMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const menu = $('#chatMenu'); menu.hidden = true;
  if (b.dataset.cmact === 'pm') {
    chatS.target = menu.dataset.id; updateTargets();
    if ($('#chatTarget').value !== menu.dataset.id) toast(t('err.bridge_player_offline'), true);
    $('#chatInput').focus();
  }
  if (b.dataset.cmact === 'only') { chatS.player = { id: menu.dataset.id, name: menu.dataset.name }; $('#chatPlayerName').textContent = menu.dataset.name; $('#chatPlayerChip').hidden = false; fetchChat(); }
});

function renderSanctions() {
  const list = state.modActive || [];
  $('#sanctionsList').innerHTML = list.length ? list.map(a => `
    <li>
      <span><b>${esc(a.name)}</b>
        ${a.mute ? `<small>${ic('mute')}${esc(fmtUntil(a.mute.until))}</small>` : ''}
        ${a.tempban ? `<small>${ic('lock')}${esc(fmtUntil(a.tempban.until))}</small>` : ''}</span>
      ${a.mute && can('players.moderate') ? `<button class="btn btn-sm btn-quiet" data-unmute="${esc(a.steamid)}">${esc(t('mod.unmute'))}</button>` : ''}
      ${a.tempban && !a.mute && can('players.ban') ? `<button class="btn btn-sm btn-quiet" data-quick="unban" data-id="${esc(a.steamid)}" data-name="${esc(a.name)}">${esc(t('pl.unban'))}</button>` : ''}
    </li>`).join('') : `<li class="empty">${esc(t('mod.noActive'))}</li>`;
}

async function loadFilterForms() {
  try {
    const [f, p] = await Promise.all([api('/mod/filter'), api('/mod/policy')]);
    state.modPolicy = p;
    const ff = $('#filterForm').elements;
    ff.words.value = f.words.join('\n'); ff.block.checked = f.block; ff.action.value = f.action; ff.muteMinutes.value = f.muteMinutes;
    $('#policyForm').elements.expireDays.value = p.expireDays;
    renderSteps(p.steps);
    applyPerms($('#chat') || document);
  } catch {}
}
function renderSteps(steps) {
  $('#policySteps').innerHTML = steps.map((st, i) => `
    <div class="step-row" data-step="${i}">
      <label class="unit unit--pre"><span>${esc(t('mod.atWarnings'))}</span><input type="number" min="1" value="${st.at}" data-k="at"></label>
      <select data-k="action">${['kick', 'mute', 'tempban', 'ban'].map(a => `<option value="${a}" ${a === st.action ? 'selected' : ''}>${esc(t('mod.sa.' + a))}</option>`).join('')}</select>
      <label class="unit" ${['mute', 'tempban'].includes(st.action) ? '' : 'hidden'}><input type="number" min="1" value="${st.minutes || 60}" data-k="minutes"><span>min</span></label>
      <button type="button" class="btn btn-sm btn-quiet btn-icon" data-rmstep="${i}" aria-label="${esc(t('common.remove'))}">${ic('trash')}</button>
    </div>`).join('') || `<p class="small">${esc(t('mod.noSteps'))}</p>`;
  applyPerms($('#policyForm').parentElement);
}
function readSteps() {
  return $$('#policySteps .step-row').map(r => ({ at: +$('[data-k=at]', r).value, action: $('[data-k=action]', r).value, minutes: +($('[data-k=minutes]', r)?.value || 0) }));
}
$('#policySteps').addEventListener('change', (e) => { if (e.target.dataset.k === 'action') renderSteps(readSteps()); });
$('#addStep').onclick = () => { const st = readSteps(); st.push({ at: (st.at(-1)?.at || 0) + 1, action: 'mute', minutes: 60 }); renderSteps(st); };
document.addEventListener('click', (e) => { const b = e.target.closest('[data-rmstep]'); if (!b) return; const st = readSteps(); st.splice(+b.dataset.rmstep, 1); renderSteps(st); });
$('#filterForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  await act(() => api('/mod/filter', { method: 'PUT', body: { words: f.words.value, block: f.block.checked, action: f.action.value, muteMinutes: f.muteMinutes.value } }), t('mod.filterSaved'));
};
$('#policyForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await act(() => api('/mod/policy', { method: 'PUT', body: { expireDays: e.target.elements.expireDays.value, steps: readSteps() } }), t('mod.policySaved'));
  if (r && r !== true) { state.modPolicy = r; renderSteps(r.steps); }
};

// ======================================================================
// Verificación en dos pasos (Cuenta)
// ======================================================================
function renderTfa() {
  const me = state.me; if (!me) return;
  const on = me.twoFactor;
  $('#tfaState').innerHTML = on
    ? `<span class="state state--on">${esc(t('tfa.on'))}</span> <span class="small">${esc(tn('tfa.codesLeft', me.recoveryLeft ?? 0))}</span>`
    : `<span class="state">${esc(t('tfa.off'))}</span>`;
  $('#tfaButtons').innerHTML = on
    ? `<button class="btn" id="tfaRegen">${esc(t('tfa.regen'))}</button><button class="btn btn-danger-outline" id="tfaDisable">${esc(t('tfa.disable'))}</button>`
    : `<button class="btn btn-primary" id="tfaEnable">${ic('lock')}${esc(t('tfa.enable'))}</button>`;
  if (on) { $('#tfaRegen').onclick = tfaRegen; $('#tfaDisable').onclick = tfaDisable; } else $('#tfaEnable').onclick = tfaEnable;
}
function wireRecovery(codes) {
  setTimeout(() => {
    $('#codesCopy').onclick = () => navigator.clipboard.writeText(codes.join('\n')).then(() => toast(t('ins.copied'))).catch(() => toast(t('common.copyFailed'), true));
    $('#codesDl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Scrapwarden - ${state.me.username}\n\n${codes.join('\n')}\n`], { type: 'text/plain' })); a.download = 'scrapwarden-recovery-codes.txt'; a.click(); };
  }, 30);
}
async function tfaEnable() {
  const s = await act(() => api('/2fa/setup', { body: {} })); if (!s || s === true) return;
  const code = await openDialog({
    title: t('tfa.setupTitle'),
    body: `<ol class="tfa-steps"><li>${esc(t('tfa.step1'))}</li><li>${esc(t('tfa.step2'))}</li></ol>
      <div class="qr">${s.qr}</div>
      <p class="small">${esc(t('tfa.manual'))} <code class="secret">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
      <label class="field"><span>${esc(t('tfa.step3'))}</span><input id="dlgInput" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code-input"></label>`,
    actions: [cancelAct(), { label: t('tfa.activate'), cls: 'btn-primary', get: () => $('#dlgInput').value.trim(), validate: () => (!/^\d{6}$/.test($('#dlgInput').value.trim()) ? t('tfa.sixDigits') : null) }],
  });
  if (!code) return;
  const r = await act(() => api('/2fa/enable', { body: { code } }), t('tfa.enabled'));
  if (!r || r === true) return;
  state.me = await api('/me'); renderTfa();
  const p = openDialog({ title: t('tfa.codesTitle'), body: `<p>${esc(t('tfa.codesBody'))}</p><pre class="codes">${r.recovery.map(esc).join('\n')}</pre><div class="btn-group"><button type="button" class="btn btn-sm" id="codesCopy">${ic('copy')}${esc(t('common.copy'))}</button><button type="button" class="btn btn-sm" id="codesDl">${ic('download')}${esc(t('common.download'))}</button></div>`, actions: [{ label: t('tfa.codesSaved'), cls: 'btn-primary', value: true }] });
  wireRecovery(r.recovery);
  await p;
}
async function askPassword(title, confirm, danger) {
  return openDialog({
    title, body: `<label class="field"><span>${esc(t('acc.current'))}</span><input id="dlgInput" type="password" autocomplete="current-password"></label>`,
    actions: [cancelAct(), { label: confirm, cls: danger ? 'btn-danger' : 'btn-primary', get: () => $('#dlgInput').value }],
  });
}
async function tfaDisable() {
  const pw = await askPassword(t('tfa.disable'), t('tfa.disable'), true); if (!pw) return;
  if (await act(() => api('/2fa/disable', { body: { password: pw } }), t('tfa.disabled'))) { state.me = await api('/me'); renderTfa(); }
}
async function tfaRegen() {
  const pw = await askPassword(t('tfa.regen'), t('tfa.regen')); if (!pw) return;
  const r = await act(() => api('/2fa/recovery', { body: { password: pw } })); if (!r || r === true) return;
  state.me = await api('/me'); renderTfa();
  const p = openDialog({ title: t('tfa.codesTitle'), body: `<p>${esc(t('tfa.codesBody'))}</p><pre class="codes">${r.recovery.map(esc).join('\n')}</pre><div class="btn-group"><button type="button" class="btn btn-sm" id="codesCopy">${ic('copy')}${esc(t('common.copy'))}</button><button type="button" class="btn btn-sm" id="codesDl">${ic('download')}${esc(t('common.download'))}</button></div>`, actions: [{ label: t('tfa.codesSaved'), cls: 'btn-primary', value: true }] });
  wireRecovery(r.recovery);
  await p;
}

// ======================================================================
// Tiempo real
// ======================================================================
let ws;
function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'console') {
      pushConsole(data);
      if (data.source === 'installer' && state.view === 'install') {
        const el = $('#instLog');
        if (el.querySelector('.src-panel:only-child')) el.innerHTML = '';
        el.insertAdjacentHTML('beforeend', lineHtml(data)); el.scrollTop = el.scrollHeight;
      }
    }
    if (type === 'status') { Object.assign(state.status, data); renderStatus(); }
    if (type === 'rcon') { state.status.rcon = data.connected; renderStatus(); }
    if (type === 'alert') onAlert(data);
    if (type === 'chatmsg') onChatMsg(data);
    if (type === 'perf') onPerf(data);
    if (type === 'update') { renderUpdate(data); toast(t('upd.toast', { v: data.latest })); }
    if (type === 'tickets') { setTicketBadge(data); if (state.view === 'tickets' && $('#dialog').hidden) loadTickets(); }
    if (type === 'vip') $('#navVip').textContent = data.active || '';
    if (type === 'banlist' && state.view === 'bans') loadBans();
    if (type === 'store' && data.purchase?.ok && data.purchase.name) toast(t('sh.toast', { name: data.purchase.name }));
    if (type === 'store' && state.view === 'store') loadStore();
    if (type === 'progress') onProgress(data);
    if (type === 'installer' && data.done) { toast(msgText(data.message), data.error); refreshStatus(); }
  };
  ws.onclose = () => setTimeout(connectWs, 3000);
}

// ======================================================================
// Arranque
// ======================================================================
let started = false;
async function boot() {
  if (!LANGS.length) await initLanguages();
  const s = await api('/setup');
  if (!s.setup) return showAuth(true);
  if (!s.authed) return showAuth(false);
  $('#auth').hidden = true;
  $('#app').hidden = false;
  [state.me, state.consoleLines, state.config] = await Promise.all([api('/me'), api('/console'), api('/config')]);
  $('#meName').textContent = state.me.username;
  $('#meRole').textContent = t('role.' + state.me.role);
  applyPerms();
  api('/panel').then(p => { state.itemIcons = p.itemIcons; }).catch(() => {});
  loadUpdate();
  await refreshStatus();
  api('/watch').then(w => { state.watch = w; setAlertBadge(w.unread); }).catch(() => {});
  if (!started) { started = true; connectWs(); setInterval(refreshStatus, 5000); }
  const want = location.hash.slice(1);
  go(VIEWS.includes(want) ? want : (state.status.installed ? 'dashboard' : 'install'));
}
// ======================================================================
// Sonido de arranque: impacto cinematográfico sintetizado con Web Audio (sin archivos)
// ======================================================================
const sfx = {
  on() { return store.get('rp_sound') !== '0'; },
  ctx: null, last: 0,
  // Construye el sonido en cualquier contexto (también OfflineAudioContext)
  build(ac, t0 = 0) {
    const sr = ac.sampleRate;
    const master = ac.createGain(); master.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
    comp.connect(master); master.connect(ac.destination);
    // Reverb: respuesta al impulso generada (ruido estéreo que decae)
    const irLen = Math.floor(sr * 2.6);
    const ir = ac.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    const verb = ac.createConvolver(); verb.buffer = ir;
    const wet = ac.createGain(); wet.gain.value = 0.42;
    verb.connect(wet); wet.connect(comp);
    const bus = (g) => { const n = ac.createGain(); n.gain.value = g; n.connect(comp); n.connect(verb); return n; };
    const noise = ac.createBuffer(1, sr * 2, sr);
    { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const env = (g, t, peak, a, dur, curve = 'exp') => {
      g.gain.setValueAtTime(0.0001, t);
      if (curve === 'lin') g.gain.linearRampToValueAtTime(peak, t + a); else g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
    };
    const T = t0 + 0.05, HIT = T + 1.38; // el golpe coincide con «PANEL»

    // 1) Subida: ruido que barre hacia agudos + tono que sube, mientras se dibuja el logo
    {
      const src = ac.createBufferSource(); src.buffer = noise;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(260, T); bp.frequency.exponentialRampToValueAtTime(5200, HIT - 0.02);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, T); g.gain.exponentialRampToValueAtTime(0.5, HIT - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, HIT + 0.02);
      src.connect(bp); bp.connect(g); g.connect(bus(1)); src.start(T); src.stop(HIT + 0.05);
      [0, 7].forEach((det) => {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.detune.value = det;
        o.frequency.setValueAtTime(70, T); o.frequency.exponentialRampToValueAtTime(420, HIT - 0.02);
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
        lp.frequency.setValueAtTime(200, T); lp.frequency.exponentialRampToValueAtTime(2600, HIT - 0.02);
        const og = ac.createGain();
        og.gain.setValueAtTime(0.0001, T); og.gain.exponentialRampToValueAtTime(0.13, HIT - 0.03);
        og.gain.exponentialRampToValueAtTime(0.0001, HIT + 0.01);
        o.connect(lp); lp.connect(og); og.connect(bus(0.9)); o.start(T); o.stop(HIT + 0.05);
      });
      // pulso que se acelera (tic-tic-tic)
      let t = T + 0.15, step = 0.22;
      while (t < HIT - 0.06) {
        const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = 1800;
        const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
        const g2 = ac.createGain(); env(g2, t, 0.05, 0.002, 0.03);
        o.connect(hp); hp.connect(g2); g2.connect(bus(0.6)); o.start(t); o.stop(t + 0.05);
        t += step; step = Math.max(0.045, step * 0.8);
      }
    }
    // 2) Silencio de 30 ms antes del golpe (lo hace más contundente) y GOLPE
    {
      // subgrave que cae
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(95, HIT); o.frequency.exponentialRampToValueAtTime(30, HIT + 1.1);
      const g = ac.createGain(); env(g, HIT, 1.0, 0.004, 1.5);
      const ws = ac.createWaveShaper(); const cv = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; cv[i] = Math.tanh(2.2 * x); } ws.curve = cv;
      o.connect(ws); ws.connect(g); g.connect(comp); o.start(HIT); o.stop(HIT + 1.6);
      // pegada: chasquido de ruido grave
      const src = ac.createBufferSource(); src.buffer = noise;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(5000, HIT); lp.frequency.exponentialRampToValueAtTime(180, HIT + 0.35);
      const ng = ac.createGain(); env(ng, HIT, 0.9, 0.002, 0.4);
      src.connect(lp); lp.connect(ng); ng.connect(bus(1)); src.start(HIT, 0.3); src.stop(HIT + 0.5);
      // metal: parciales inarmónicos de una placa de acero, con cola larga en la reverb
      [[118, 0.32, 1.9], [326, 0.22, 1.5], [641, 0.14, 1.2], [1057, 0.09, 0.9], [1583, 0.06, 0.7], [2212, 0.04, 0.5]].forEach(([f, a, d]) => {
        const m = ac.createOscillator(); m.type = 'sine'; m.frequency.value = f;
        const mg = ac.createGain(); env(mg, HIT, a, 0.003, d);
        m.connect(mg); mg.connect(bus(1)); m.start(HIT); m.stop(HIT + d + 0.1);
      });
      // acorde oscuro que queda flotando (power chord)
      [55, 82.4, 110].forEach((f, k) => [-6, 6].forEach((det) => {
        const c = ac.createOscillator(); c.type = 'sawtooth'; c.frequency.value = f; c.detune.value = det;
        const lpf = ac.createBiquadFilter(); lpf.type = 'lowpass';
        lpf.frequency.setValueAtTime(1400, HIT); lpf.frequency.exponentialRampToValueAtTime(160, HIT + 2);
        const cg = ac.createGain(); env(cg, HIT, 0.07 / (k + 1), 0.01, 2.1);
        c.connect(lpf); lpf.connect(cg); cg.connect(bus(0.8)); c.start(HIT); c.stop(HIT + 2.2);
      }));
    }
    return 3.6;
  },
  play(force = false) {
    if (!force && !sfx.on()) return false;
    if (Date.now() - sfx.last < 4000) return true;
    try {
      sfx.ctx = sfx.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (sfx.ctx.state !== 'running') { sfx.ctx.resume().catch(() => {}); if (sfx.ctx.state !== 'running' && !force) return false; }
      sfx.build(sfx.ctx, sfx.ctx.currentTime + 0.02);
      sfx.last = Date.now();
      return true;
    } catch { return false; }
  },
};
// Animación de arranque: dura ~2,6 s; clic o tecla para saltarla
(function splash() {
  const el = $('#splash');
  if (!el) return;
  const done = () => el.remove();
  // Los navegadores no dejan sonar audio hasta que el usuario interactúa:
  // si está bloqueado, suena al iniciar sesión (que sí es una interacción).
  sfx.play();
  const skip = () => { el.classList.add('is-skip'); setTimeout(done, 220); };
  el.addEventListener('animationend', (e) => { if (e.target === el) done(); });
  el.addEventListener('click', skip);
  addEventListener('keydown', skip, { once: true });
  setTimeout(done, 3200); // por si el navegador no lanza animationend
})();
$('#soundOn').checked = sfx.on();
$('#soundOn').onchange = (e) => store.set('rp_sound', e.target.checked ? '1' : '0');
$('#soundTest').onclick = () => { sfx.last = 0; sfx.play(true); };
boot();
