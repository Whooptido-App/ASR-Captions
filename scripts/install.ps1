# Whooptido ASR Captions — Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.ps1 | iex
#
# What this does:
# 1. Downloads the Windows x64 binary from GitHub Releases
# 2. Installs it to %LOCALAPPDATA%\Whooptido\
# 3. Creates the native messaging host manifest
# 4. Registers in the Windows Registry for Chrome

$ErrorActionPreference = "Stop"

# --- Configuration ---
$Repo = "Whooptido-App/ASR-Captions"
$HostName = "com.whooptido.companion"
$InstallDir = "$env:LOCALAPPDATA\Whooptido"
$BinaryName = "whooptido-asr-captions.exe"
$Asset = "whooptido-asr-captions-windows-x64.exe"
# Extension ID — update if CWS ID changes
$ExtensionId = "iabpcgbkbkkeokigbgogggaoejnbkikn"

function Write-Step($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   Whooptido ASR Captions — Installer     ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# --- Download binary ---
Write-Step "Downloading $Asset..."

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$DownloadUrl = "https://github.com/$Repo/releases/latest/download/$Asset"
$BinaryPath = Join-Path $InstallDir $BinaryName

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing
    Write-Ok "Binary installed: $BinaryPath"
} catch {
    Write-Fail "Download failed. Check https://github.com/$Repo/releases for available assets."
}

# --- Create native messaging host manifest ---
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$BinaryPathEscaped = $BinaryPath.Replace('\', '\\')

$Manifest = @"
{
  "name": "$HostName",
  "description": "Whooptido ASR Captions Companion",
  "path": "$BinaryPathEscaped",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@

$Manifest | Out-File -FilePath $ManifestPath -Encoding utf8
Write-Ok "Manifest created: $ManifestPath"

# --- Register in Windows Registry ---
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

try {
    New-Item -Path $RegPath -Force | Out-Null
    Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath
    Write-Ok "Registry key set: $RegPath"
} catch {
    Write-Fail "Failed to set registry key. Try running as Administrator."
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   Installation complete!                 ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Binary:   $BinaryPath"
Write-Host "  Manifest: $ManifestPath"
Write-Host "  Registry: $RegPath"
Write-Host ""
Write-Host "  Restart Chrome, then enable Word-for-Word Captions"
Write-Host "  in the Whooptido extension settings."
Write-Host ""
Write-Host "  To uninstall:"
Write-Host "    irm https://raw.githubusercontent.com/$Repo/main/scripts/uninstall.ps1 | iex"
Write-Host ""
