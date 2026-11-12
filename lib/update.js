// Aviso de versiones nuevas: consulta la última release publicada en GitHub (una petición cada 6 horas).
// Solo lee; nunca descarga ni instala nada. Se desactiva con panel.updateCheck = false o OXIDIAN_NO_UPDATE_CHECK=1.
const config = require('./config');
const { bus, log } = require('./bus');
const { L } = require('./i18n');
const pkg = require('../package.json');

const REPO = 'jvlsile/oxidian';
const CURRENT = pkg.version;
const IS_PRE = /-/.test(CURRENT);
// Las betas también reciben avisos de otras betas; las versiones estables solo de estables.
// /releases/latest de GitHub no incluye las marcadas como pre-release, por eso se pide la lista.
const API = process.env.OXIDIAN_UPDATE_API || `https://api.github.com/repos/${REPO}/releases?per_page=15`;
let state = { current: CURRENT, latest: null, url: `https://github.com/${REPO}/releases`, notes: '', publishedAt: null, checkedAt: null, error: null };
let timer = null, announced = null;

const enabled = () => !process.env.OXIDIAN_NO_UPDATE_CHECK && config.get().panel.updateCheck !== false;

// Compara versiones semver: 1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0-rc.1 < 1.0.0 < 1.0.1
function parse(v) {
  const [core, pre = ''] = String(v || '').trim().replace(/^v/i, '').split('+')[0].split(/-(.*)/s);
  return { n: core.split('.').map(x => parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] };
}
function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) - (y.n[i] || 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0); // sin etiqueta = estable = mayor
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p - +q; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
const newer = (a, b) => cmp(a, b) > 0;

async function check() {
  if (!enabled()) return view();
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Oxidian/${CURRENT}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) { state.latest = null; state.error = null; } // el repositorio aún no existe
    else if (!res.ok) throw new Error(`GitHub ${res.status}`);
    else {
      let list = await res.json();
      if (!Array.isArray(list)) list = [list];
      const ok = list.filter(r => r && !r.draft && r.tag_name && (IS_PRE || !(r.prerelease || /-/.test(r.tag_name))));
      ok.sort((a, b) => cmp(b.tag_name, a.tag_name));
      const r = ok[0];
      if (r) {
        state.latest = String(r.tag_name).replace(/^v/i, '');
        state.url = r.html_url || state.url;
        state.notes = String(r.body || '').slice(0, 4000);
        state.publishedAt = r.published_at ? Date.parse(r.published_at) : null;
      } else state.latest = null;
      state.error = null;
    }
  } catch (e) { state.error = String(e.message || e); }
  state.checkedAt = Date.now();
  const v = view();
  if (v.available && announced !== state.latest) {
    announced = state.latest;
    log('panel', L('update_available', { v: state.latest }));
    bus.emit('update', v);
  }
  return v;
}

function view() {
  return { ...state, beta: IS_PRE, enabled: enabled(), available: !!(state.latest && newer(state.latest, CURRENT)) };
}

function setEnabled(on) {
  config.update('panel', { updateCheck: !!on });
  if (on) check().catch(() => {});
  return view();
}

function start() {
  setTimeout(() => check().catch(() => {}), 15000);
  timer = setInterval(() => check().catch(() => {}), 6 * 3600 * 1000);
}

module.exports = { start, check, view, setEnabled, newer, cmp, CURRENT };
