#!/usr/bin/env bash
# Instalador de Scrapwarden para Ubuntu/Debian (22.04+ recomendado)
# Uso: sudo bash install.sh
set -e

if [ "$EUID" -ne 0 ]; then echo "Ejecuta con sudo: sudo bash install.sh"; exit 1; fi

PANEL_USER=${PANEL_USER:-rustserver}
PANEL_DIR=${PANEL_DIR:-/opt/scrapwarden}
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Instalando dependencias del sistema (SteamCMD necesita librerías de 32 bits)"
dpkg --add-architecture i386 || true
apt-get update
apt-get install -y curl ca-certificates tar unzip lib32stdc++6
apt-get install -y lib32gcc-s1 || apt-get install -y lib32gcc1 || true
apt-get install -y libsdl2-2.0-0:i386 || true

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> Instalando Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Creando usuario $PANEL_USER"
id "$PANEL_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$PANEL_USER"

echo "==> Copiando panel a $PANEL_DIR"
mkdir -p "$PANEL_DIR"
cp -r "$SRC_DIR"/{server.js,package.json,lib,public,README.md} "$PANEL_DIR"/
cd "$PANEL_DIR"
npm install --omit=dev
chown -R "$PANEL_USER":"$PANEL_USER" "$PANEL_DIR"

# Servicio de versiones anteriores (antes de llamarse Scrapwarden)
if [ -f /etc/systemd/system/rust-panel.service ]; then
  systemctl disable --now rust-panel 2>/dev/null || true
  rm -f /etc/systemd/system/rust-panel.service
fi

echo "==> Creando servicio systemd scrapwarden"
cat > /etc/systemd/system/scrapwarden.service <<EOF
[Unit]
Description=Scrapwarden
After=network-online.target
Wants=network-online.target

[Service]
User=$PANEL_USER
WorkingDirectory=$PANEL_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120
LimitNOFILE=100000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now scrapwarden

if command -v ufw >/dev/null; then
  echo "==> Abriendo puertos en ufw"
  ufw allow 28015/udp; ufw allow 28017/udp; ufw allow 28082/tcp; ufw allow 8080/tcp
fi

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "✔ Scrapwarden instalado. Abre http://$IP:8080 para crear tu contraseña de administrador."
echo "  Logs: journalctl -u scrapwarden -f"
