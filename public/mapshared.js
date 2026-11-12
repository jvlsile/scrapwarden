// Compartido por el panel y la web pública: iconos de monumentos y estilo de las rutas del mapa
const PATH_STYLE = {
  rivers: [['#4F8FB3', 3, '', .9]],
  roads: [['#3D3526', 5, '', .95], ['#D9C79A', 3, '', 1]],
  rails: [['#2A2A2A', 4, '', .95], ['#CFCFCF', 2, '4 3', 1]],
  power: [['#E0B252', 1.5, '2 4', .9]],
};

// Iconos de monumentos (como los del mapa del juego), elegidos por el nombre
const MON_SVG = {
  rocket: '<path d="M12 3c3 2 4 6 4 10l-2 3h-4l-2-3c0-4 1-8 4-10z"/><path d="M10 16l-2 4M14 16l2 4"/><circle cx="12" cy="9" r="1.5"/>',
  plane: '<path d="M3 13l8-2V5a1 1 0 0 1 2 0v6l8 2v2l-8-1v4l2 2v1l-3-1-3 1v-1l2-2v-4l-8 1z"/>',
  safe: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  mask: '<path d="M4 8c3-2 13-2 16 0 0 6-3 10-8 10S4 14 4 8z"/><path d="M8 11h2M14 11h2"/>',
  tunnel: '<path d="M4 20V11a8 8 0 0 1 16 0v9"/><path d="M8 20v-8a4 4 0 0 1 8 0v8"/>',
  drop: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>',
  bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  train: '<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9 16v4M15 16v4"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13a7 7 0 0 0 14 0M9 10h6"/>',
  dome: '<path d="M3 18h18M5 18a7 7 0 0 1 14 0"/><path d="M12 11V4"/>',
  light: '<path d="M10 21l1-12h2l1 12z"/><path d="M9 9h6M12 3v3M7 5l2 2M17 5l-2 2"/>',
  oil: '<path d="M12 3l-5 18M12 3l5 18M8 15h8M9.5 10h5"/>',
  dish: '<path d="M5 14a7 7 0 0 0 10 0z"/><path d="M10 14l4-4M14 10l2-2M12 21v-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  ship: '<path d="M3 15l2 5h14l2-5z"/><path d="M6 15V9h12v6M9 9V5h6v4"/>',
  snow: '<path d="M12 3v18M4 7.5l16 9M4 16.5l16-9"/>',
  missile: '<path d="M12 2c2 2 3 5 3 9v6H9v-6c0-4 1-7 3-9z"/><path d="M9 17l-2 4h10l-2-4"/>',
  store: '<path d="M4 10h16v10H4zM3 10l2-5h14l2 5"/><path d="M10 20v-5h4v5"/>',
  fish: '<path d="M3 12c4-5 10-5 14 0-4 5-10 5-14 0z"/><path d="M17 12l4-3v6z"/>',
  horse: '<path d="M6 20v-6l3-4-2-4 4 2 5 1 2 3-3 1v7"/>',
  pin: '<path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
};
const MON_RULES = [
  [/launch/i, 'rocket'], [/airfield/i, 'plane'], [/outpost|compound/i, 'safe'], [/bandit/i, 'mask'],
  [/military tunnel|tunnel/i, 'tunnel'], [/water treatment|water well|reservoir/i, 'drop'], [/power ?plant/i, 'bolt'],
  [/train ?yard|train station|rail/i, 'train'], [/harbou?r|ferry/i, 'anchor'], [/dome|sphere/i, 'dome'], [/lighthouse/i, 'light'],
  [/oil ?rig|oilrig/i, 'oil'], [/satellite/i, 'dish'], [/junk ?yard|scrapyard/i, 'gear'], [/arctic|research/i, 'snow'],
  [/missile|silo/i, 'missile'], [/supermarket|gas station|warehouse|mining outpost|oxum/i, 'store'], [/fishing/i, 'fish'],
  [/ranch|stable/i, 'horse'], [/excavator|quarry/i, 'gear'], [/underwater|lab/i, 'drop'], [/cargo/i, 'ship'],
];
function monIcon(m) {
  const key = (MON_RULES.find(([re]) => re.test(m.name || '') || re.test(m.prefab || '')) || [0, 'pin'])[1];
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${MON_SVG[key]}</svg>`;
}
