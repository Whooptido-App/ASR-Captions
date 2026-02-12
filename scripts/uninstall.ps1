# Whooptido ASR Captions — Uninstaller for Windows
# Usage: irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"

$HostName = "com.whooptido.companion"
$InstallDir = "$env:LOCALAPPDATA\Whooptido"
$BinaryName = "whooptido-asr-captions.exe"

function Write-Step($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Red
Write-Host "  ║   Whooptido ASR Captions — Uninstaller   ║" -ForegroundColor Red
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Red
Write-Host ""

# --- Remove registry key ---
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (Test-Path $RegPath) {
    Remove-Item -Path $RegPath -Force
    Write-Ok "Removed registry key: $RegPath"
} else {
    Write-Step "No registry key found at: $RegPath"
}

# --- Remove manifest ---
$ManifestPath = Join-Path $InstallDir "$HostName.json"
if (Test-Path $ManifestPath) {
    Remove-Item -Path $ManifestPath -Force
    Write-Ok "Removed manifest: $ManifestPath"
} else {
    Write-Step "No manifest found at: $ManifestPath"
}

# --- Remove binary ---
$BinaryPath = Join-Path $InstallDir $BinaryName
if (Test-Path $BinaryPath) {
    Remove-Item -Path $BinaryPath -Force
    Write-Ok "Removed binary: $BinaryPath"
} else {
    Write-Step "No binary found at: $BinaryPath"
}

# --- Remove install directory if empty ---
if ((Test-Path $InstallDir) -and ((Get-ChildItem $InstallDir | Measure-Object).Count -eq 0)) {
    Remove-Item -Path $InstallDir -Force
    Write-Ok "Removed empty directory: $InstallDir"
}

Write-Host ""
Write-Ok "Whooptido ASR Captions has been uninstalled."
Write-Host "  Restart Chrome for changes to take effect."
Write-Host ""
