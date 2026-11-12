# Instalador de Oxidian para Windows 10/11 y Windows Server 2019+
# Uso: clic derecho > "Ejecutar con PowerShell" (como administrador)
#   o: powershell -ExecutionPolicy Bypass -File install-windows.ps1

$ErrorActionPreference = 'Stop'
$PanelDir = $PSScriptRoot
$Port = 8080

function Paso($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

# Elevar a administrador si hace falta (para abrir puertos en el firewall)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

Paso "Comprobando Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
$okVersion = $false
if ($node) { $okVersion = [int]((node -p "process.versions.node.split('.')[0]")) -ge 18 }
if (-not $okVersion) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Instalando Node.js LTS con winget..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    Write-Host "Instala Node.js 18 o superior desde https://nodejs.org y vuelve a ejecutar este script." -ForegroundColor Yellow
    Read-Host "Pulsa Enter para salir"; exit 1
  }
}

Paso "Instalando dependencias del panel"
Set-Location $PanelDir
npm install --omit=dev

Paso "Abriendo puertos en el Firewall de Windows"
$reglas = @(
  @{ n = 'Rust juego';  p = 'UDP'; port = 28015 },
  @{ n = 'Rust query';  p = 'UDP'; port = 28017 },
  @{ n = 'Rust+ app';   p = 'TCP'; port = 28082 },
  @{ n = 'Oxidian';  p = 'TCP'; port = $Port }
)
foreach ($r in $reglas) {
  if (-not (Get-NetFirewallRule -DisplayName $r.n -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $r.n -Direction Inbound -Protocol $r.p -LocalPort $r.port -Action Allow | Out-Null
    Write-Host "  Abierto $($r.port)/$($r.p) ($($r.n))"
  }
}

Paso "Arranque automático"
$resp = Read-Host "¿Quieres que el panel arranque solo al iniciar Windows? (s/n)"
if ($resp -match '^[sS]') {
  $nodeExe = (Get-Command node).Source
  $accion = New-ScheduledTaskAction -Execute $nodeExe -Argument 'server.js' -WorkingDirectory $PanelDir
  $disparo = New-ScheduledTaskTrigger -AtStartup
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
  # Tarea de versiones anteriores (antes de llamarse Oxidian)
  Unregister-ScheduledTask -TaskName 'Rust Panel' -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName 'Oxidian' -Action $accion -Trigger $disparo -Settings $ajustes -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName 'Oxidian'
  Write-Host "  Tarea programada 'Oxidian' creada y en marcha."
} else {
  Write-Host "  Puedes arrancarlo cuando quieras con start-windows.bat"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "cd /d `"$PanelDir`" && node server.js" -WorkingDirectory $PanelDir
}

Start-Sleep -Seconds 2
Start-Process "http://localhost:$Port"
Write-Host "`nListo. Abre http://localhost:$Port y crea tu contraseña de administrador." -ForegroundColor Green
Write-Host "Si juegas desde fuera de tu red, redirige en el router los puertos 28015/UDP, 28017/UDP y 28082/TCP a este PC."
Read-Host "Pulsa Enter para cerrar"
