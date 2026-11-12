// Roles y permisos del panel
const PERMS = [
  'view',             // ver todo el panel (solo lectura)
  'console',          // enviar comandos RCON
  'players.kick',     // expulsar y escribir en el chat
  'players.moderate', // silenciar, advertir, notas, mensajes privados
  'players.ban',      // banear y desbanear
  'players.admin',    // dar o quitar admin/moderador del juego
  'players.give',     // dar objetos
  'inventory.view',
  'inventory.edit',
  'watch.review',     // revisar alertas y comprobar perfiles
  'watch.settings',   // umbrales, Discord, Steam, complemento
  'plugins',
  'perms',            // permisos de Oxide/Carbon
  'server.control',   // iniciar, detener, reiniciar, guardar
  'server.config',
  'schedule',
  'backups',
  'wipe',
  'install',
  'users',            // gestionar administradores del panel
  'audit',            // ver el registro de actividad
];

const ROLES = {
  owner: PERMS,
  admin: PERMS.filter(p => p !== 'users'),
  moderator: ['view', 'players.kick', 'players.moderate', 'players.ban', 'inventory.view', 'watch.review'],
  viewer: ['view'],
};

const permsOf = (role) => ROLES[role] || [];
const can = (user, perm) => !perm || (user && permsOf(user.role).includes(perm));

module.exports = { PERMS, ROLES, permsOf, can };
