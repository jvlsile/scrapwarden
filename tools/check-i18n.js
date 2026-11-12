#!/usr/bin/env node
// Comprueba que todos los idiomas tengan las claves que usan la interfaz y el servidor.
// Uso: node tools/check-i18n.js [--list]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const used = new Set();
const add = (k) => used.add(k);

// HTML: data-i18n*, data-i18n-html, -ph, -title, -aria
for (const m of read('public/index.html').matchAll(/data-i18n(?:-html|-ph|-title|-aria)?="([^"]+)"/g)) add(m[1]);

// JS de la interfaz: t('...'), tn('...') (plural), t(`...`) estáticas
const app = read('public/app.js');
for (const m of app.matchAll(/\bt\('([\w.]+)'/g)) add(m[1]);
for (const m of app.matchAll(/\btn\('([\w.]+)'/g)) { add(m[1] + '_one'); add(m[1] + '_other'); }
for (const m of app.matchAll(/t\([\w.]+ \? '([\w.]+)' : '([\w.]+)'/g)) { add(m[1]); add(m[2]); }
for (const m of app.matchAll(/'((?:bk|inv|watch|ins|pl|plg|act|hist|perm|sch|acc|dash|steam|team|map|adm|audit|role|mod|chat|tfa)\.[\w.]+)'/g)) add(m[1]);

// Web pública (public/server.html): data-t="..." y t('...')
const pubPage = read('public/server.html');
for (const m of pubPage.matchAll(/data-t="([\w.]+)"/g)) add(m[1]);
for (const m of pubPage.matchAll(/\bt\('([\w.]+)'/g)) add(m[1]);
for (const m of pubPage.matchAll(/'(pub\.[\w.]+)'/g)) add(m[1]);
for (const m of pubPage.matchAll(/t\([\w.]+ \? '([\w.]+)' : '([\w.]+)'/g)) { add(m[1]); add(m[2]); }

// Claves dinámicas conocidas
const dyn = {
  'status.': ['running', 'starting', 'stopping', 'stopped'],
  'sev.': ['low', 'medium', 'high'],
  'kind.': ['antihack', 'report', 'aim', 'distance', 'kills', 'evasion', 'shared-ip', 'log', 'steam', 'team', 'ip'],
  'role.': ['owner', 'admin', 'moderator', 'viewer'],
  'role.help.': ['owner', 'admin', 'moderator', 'viewer'],
  'steam.mode.': ['off', 'alert', 'kick'],
  'map.ev.': ['cargo', 'heli', 'bradley', 'chinook'],
  'kick.': ['steam_ban', 'steam_community', 'steam_new', 'steam_private', 'steam_hours'],
  'audit.a.': ['password', 'user_create', 'user_update', 'user_delete', 'notify_lang', 'config', 'schedule', 'platform', 'install_server', 'install_framework', 'server_start', 'server_stop', 'server_restart', 'server_kill', 'server_restart_warned', 'server_save', 'rcon', 'say', 'player_kick', 'player_ban', 'player_unban', 'player_owner', 'player_moderator', 'player_removeowner', 'player_removemoderator', 'player_give', 'inventory_remove', 'inventory_clear', 'alerts', 'steam_check', 'watch_bridge', 'watch_test_discord', 'watch_settings', 'steam_settings', 'plugin_install', 'plugin_upload', 'plugin_enable', 'plugin_disable', 'plugin_reload', 'plugin_delete', 'plugin_config', 'perm_grant', 'perm_revoke', 'perm_addgroup', 'perm_removegroup', 'perm_usergroup_add', 'perm_usergroup_remove', 'backup_create', 'backup_restore', 'backup_delete', 'wipe', '2fa_enable', '2fa_disable', '2fa_recovery', 'chat_pm', 'mod_note', 'mod_warn', 'mod_mute', 'mod_unmute', 'mod_note_delete', 'mod_warn_delete', 'mod_tempban', 'mod_policy', 'mod_filter', 'item_icons', 'rates', 'pve_mode', 'world_time', 'world_weather', 'world_event', 'wipe_plan', 'wipe_skip', 'perf', 'public_page', 'discord_bot', 'discord_say', 'ticket_assign', 'ticket_unassign', 'ticket_comment', 'ticket_reopen', 'ticket_close', 'vip_grant', 'vip_remove', 'vip_settings', 'staff_add', 'staff_remove', 'ingame_tp', 'ingame_bring', 'ingame_heal', 'ingame_warn', 'ingame_mute', 'ingame_unmute', 'ingame_kick', 'ingame_tempban1', 'ingame_tempban7', 'ingame_ban', 'ingame_ticket', 'ingame_world', 'store_settings', 'store_delivery', 'update_check', 'server_import', 'remote_mode', 'remote_disable', 'ipcheck_settings', 'remote_files'],
  'task.': ['server', 'oxide', 'carbon'],
  'phase.': ['starting', 'steamcmd_dl', 'steamcmd_update', 'allocating', 'downloading', 'verifying', 'committing', 'framework_dl', 'framework_extract'],
  'act.done.': ['start', 'stop', 'restart', 'kill'],
  'pl.done.': ['kick', 'ban', 'unban', 'owner', 'moderator', 'removeowner', 'removemoderator', 'give'],
  'perm.done.': ['grant', 'revoke', 'addgroup', 'removegroup', 'usergroup-add', 'usergroup-remove'],
  'nav.': ['dashboard', 'console', 'chat', 'map', 'players', 'watch', 'plugins', 'perms', 'config', 'schedule', 'backups', 'install', 'admins', 'wiki', 'settings', 'tickets', 'vip', 'staff', 'store'],
  'game.': ['restart_in_1', 'restart_in_n', 'restart_now', 'chat_blocked', 'you_are_muted', 'muted_for', 'muted', 'unmuted', 'warned', 'tempban_reason', 'rates_changed', 'mode_pve', 'mode_pvp', 'wipe_in_hours', 'wipe_in_1h', 'wipe_in_minutes', 'wipe_in_1', 'wipe_now', 'ticket_reason', 'report_reviewed', 'report_actioned', 'vip_granted', 'vip_granted_perm', 'vip_ending', 'vip_expired', 'vip_extended'],
  'wp.h.': ['manual'],
  'dc.st.': ['off', 'connecting', 'ready', 'error'],
  'dc.': ['cmd.status', 'cmd.players', 'cmd.wipe', 'cmd.say', 'cmd.kick', 'cmd.ban', 'opt.message', 'opt.player', 'opt.reason', 'disabled', 'offline', 'status.players', 'status.fps', 'status.uptime', 'status.wipe', 'players.none', 'players.title', 'wipe.next', 'wipe.forced', 'wipe.none', 'said', 'many', 'notFound', 'notOnline', 'defaultKick', 'defaultBan', 'kicked', 'banned', 'error', 'presence.on', 'presence.off', 'cmd.vip', 'cmd.tickets', 'opt.days', 'opt.group', 'tickets.none', 'tickets.title', 'tickets.line', 'vip.badGroup', 'vip.granted', 'vip.granted_perm'],
  'err.discord_': ['bad_token', 'intents'],
  'log.discord_': ['kicked', 'banned'],
  'pf.upload': ['Ok', 'Fail', 'None'],
  'pf.ph.': ['process', 'assets', 'world', 'mapupload', 'plugins'],
  'pf.tip.': ['mapupload', 'antivirus', 'disk', 'mapgen', 'bigmap', 'pluginerr', 'plugins', 'ram', 'priority', 'slow'].flatMap(c => [c + '.title', c + '.body']),
  'pf.ev.': ['hang', 'fps', 'fps_ok', 'ram', 'restart_hang', 'restart_fps'].flatMap(c => [c + '.title', c + '.detail']),
  'log.perf_': ['hang', 'fps', 'fps_ok', 'ram', 'restart_hang', 'restart_fps'],
  'rt.': ['installBridge', 'reinstallBridge', 'updateBridge'],
  'log.': ['wipe_auto_forced', 'wipe_auto_start'],
  'wd2.': ['discordSoonTitle', 'discordSoon', 'discordSoonBp', 'discordDoneTitle', 'discordDone', 'discordDoneBp', 'discordFailTitle'],
  'mod.sa.': ['kick', 'mute', 'tempban', 'ban'],
  'mod.': ['filterReason', 'autoReason'],
  'discord.': ['player', 'severity'],
  'tk.st.': ['open', 'progress', 'closed'],
  'tk.res.': ['none', 'warn', 'mute', 'kick', 'tempban', 'ban'],
  'tk.kind.': ['cheat', 'abuse', 'abusive', 'name', 'spam', 'other'],
  'tk.sys.': ['reopened'],
  'tk.ok.': ['assign', 'unassign', 'reopen', 'closed', 'closedNotified'],
  'tk.k.': ['open', 'progress', 'multi'],
  'vip.reason.': ['expired', 'removed'],
  'tk.': ['empty', 'emptyClosed'],
  'sh.st.': ['off', 'waiting', 'ready', 'error'],
  'rem.st.': ['on', 'waiting', 'off'],
  'ipc.hint.': ['proxycheck', 'ipapi'],
  'ipc.': ['keySaved', 'keyMissing'],
  'kick.ip_': ['vpn', 'hosting', 'country'],
  'err.ipcheck_': ['limit', 'status', 'bad_key'],
  'rem.note.': ['plugins', 'backups', 'wipes', 'schedule', 'config', 'perf'],
  'rem.': ['passSaved', 'passHint'],
  'imp.w.': ['platform', 'no_script', 'no_identity', 'rcon_web_off', 'no_rcon_password'],
  'imp.': ['doneRunning', 'doneStopped'],
  'err.remote_': ['timeout', 'refused', 'auth', 'not_found', 'unreachable', 'bad_address'],
  'log.': ['remote_attached', 'local_attached', 'wipe_auto_forced', 'wipe_auto_start'],
  'act.': ['stopBodyRemote', 'restartBodyRemote'],
  'sh.': ['ok', 'retry', 'failed', 'secretSaved', 'secretHint', 'ex.vip', 'ex.group', 'ex.perm', 'ex.item', 'ex.say'],
  'store.': ['discordTitle', 'discordBody'],
  'log.store_': ['delivered', 'failed'],
  'game.store_': ['thanks'],
  'ig.': ['title', 'lvl.mod', 'lvl.admin', 'tab.players', 'tab.reports', 'tab.world', 'close', 'pick', 'health', 'warns', 'team', 'muted', 'sleeping', 'reason', 'a.tp', 'a.bring', 'a.heal', 'a.warn', 'a.mute', 'a.unmute', 'a.kick', 'a.tempban1', 'a.tempban7', 'a.ban', 'a.ticketLog', 'a.worldLog', 'confirm', 'noReports', 'rep.line', 'r.none', 'r.warn', 'r.kick', 'r.tempban', 'w.time', 'w.day', 'w.night', 'w.weather', 'w.clear', 'w.storm', 'w.events', 'w.cargo', 'w.heli', 'w.airdrop', 'w.chinook', 'sent', 'noperm', 'offline', 'notify', 'done.tp', 'done.bring', 'done.heal', 'done', 'failed', 'welcome', 'defaultReason'],
  'stf.lvl.': ['mod', 'admin'],
  'stf.': ['noBridge', 'offline', 'toMod', 'toAdmin'],
  'vip.': ['ok', 'okPerm'],
  'log.vip_': ['expired', 'removed', 'granted', 'granted_perm', 'extended'],
};
for (const [p, list] of Object.entries(dyn)) list.forEach(x => add(p + x));
for (const code of ['antihack_high', 'antihack', 'report_many', 'report', 'aim', 'distance', 'distance_head', 'kills', 'evasion', 'shared_ip', 'log_kick', 'log_antihack', 'test', 'steam_ban', 'steam_community', 'steam_new', 'steam_private', 'steam_hours', 'team_size', 'team_group', 'ip_vpn', 'ip_hosting', 'ip_country']) {
  add(`alert.${code}.title`); add(`alert.${code}.detail`);
}

// Servidor: E('code'), L('key'), errores de OxidianBridge, cfg.<campo>
const backend = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)].map(read).join('\n');
for (const m of backend.matchAll(/\bE\('([\w]+)'/g)) add('err.' + m[1]);
for (const m of backend.matchAll(/\bfail\(res, \d+, '([\w]+)'/g)) add('err.' + m[1]);
for (const m of backend.matchAll(/\bL\('([\w]+)'/g)) add('log.' + m[1]);
for (const m of backend.matchAll(/\bL\(\w+ \? '([\w]+)' : '([\w]+)'/g)) { add('log.' + m[1]); add('log.' + m[2]); }
for (const m of read('lib/bridge/OxidianBridge.cs').matchAll(/error = "(\w+)"/g)) add('err.bridge_' + m[1]);
for (const m of read('server.js').matchAll(/^\s+(\w+): '(?:str|int|port|bool|id|platform)'/gm)) add('cfg.' + m[1]);
['session_expired', 'bad_request_json', 'forbidden', 'map_not_ready', 'bridge_map_render'].forEach(k => add('err.' + k));
add('alert.kicked');

for (const k of [...used]) if (/[._-]$/.test(k) || used.has(k + '_one') || ['watch.review', 'watch.settings'].includes(k)) used.delete(k);
const keys = [...used].sort();
if (process.argv.includes('--list')) { console.log(keys.join('\n')); process.exit(0); }

let bad = 0;
const files = fs.readdirSync(path.join(root, 'public/i18n')).filter(f => f.endsWith('.json'));
for (const f of files) {
  const j = JSON.parse(read('public/i18n/' + f));
  const missing = keys.filter(k => !(k in j.strings));
  const unused = Object.keys(j.strings).filter(k => !used.has(k));
  const es = JSON.parse(read('public/i18n/es.json'));
  const wikiIds = (j.wiki || []).map(s => s.id).join(',');
  const esWikiIds = (es.wiki || []).map(s => s.id).join(',');
  // Comprueba que los parámetros {x} coincidan con el español
  const paramMismatch = Object.keys(es.strings).filter(k => k in j.strings && [...es.strings[k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join() !== [...j.strings[k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join());
  console.log(`${f}: ${Object.keys(j.strings).length} textos, ${(j.wiki || []).length} secciones de wiki` +
    (missing.length ? `\n  FALTAN (${missing.length}): ${missing.join(', ')}` : '') +
    (unused.length ? `\n  sin uso (${unused.length}): ${unused.join(', ')}` : '') +
    (paramMismatch.length ? `\n  PARÁMETROS DISTINTOS: ${paramMismatch.join(', ')}` : '') +
    (wikiIds !== esWikiIds ? `\n  WIKI con secciones distintas a es` : ''));
  if (missing.length || paramMismatch.length || wikiIds !== esWikiIds) bad++;
}
process.exit(bad ? 1 : 0);
