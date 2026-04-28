# Whooptido ASR Captions — Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.ps1 | iex
#
# What this does:
# 1. Downloads the Windows x64 binary from GitHub Releases
# 2. Detects NVIDIA or AMD acceleration hardware
# 3. Downloads the matching accelerated whisper.cpp runtime used by the companion
# 4. Installs both to %LOCALAPPDATA%\Whooptido\
# 5. Creates the native messaging host manifest
# 6. Registers in the Windows Registry for Chrome

$ErrorActionPreference = "Stop"

# --- Configuration ---
$Repo = "Whooptido-App/ASR-Captions"
$HostName = "com.whooptido.companion"
$InstallDir = "$env:LOCALAPPDATA\Whooptido"
$BinaryName = "whooptido-asr-captions.exe"
$Asset = "whooptido-asr-captions-windows-x64.exe"
# Extension IDs allowed to connect to the native host.
# pjac... is the current packaged/unpacked Whooptido ID; iab... is retained for older beta installs.
$PrimaryExtensionId = "pjacfbdlalhafifgdoddiojjjeabkhcg"
$LegacyExtensionId = "iabpcgbkbkkeokigbgogggaoejnbkikn"

function Write-Step($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Get-VideoControllerNames {
  try {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object { $_.Name }
    return @($controllers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  } catch {
    try {
      $controllers = Get-WmiObject Win32_VideoController -ErrorAction Stop | ForEach-Object { $_.Name }
      return @($controllers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    } catch {
      return @()
    }
  }
}

function Get-NvidiaDevices {
  $devices = @()
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    try {
      $devices = @(& $nvidiaSmi.Source --query-gpu=name --format=csv,noheader 2>$null | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    } catch {
      $devices = @()
    }
  }

  if ($devices.Count -gt 0) { return $devices }

  return @(Get-VideoControllerNames | Where-Object { $_ -match 'NVIDIA' })
}

function Get-AmdDevices {
  return @(Get-VideoControllerNames | Where-Object { $_ -match 'AMD|Radeon|Advanced Micro Devices' })
}

function Select-WhisperRuntime {
  $nvidiaDevices = @(Get-NvidiaDevices)
  if ($nvidiaDevices.Count -gt 0) {
    return [pscustomobject]@{
      Backend = 'cuda'
      DisplayName = 'NVIDIA CUDA'
      Asset = 'whooptido-whisper-runtime-windows-x64-cuda.zip'
      ExpectedDll = 'ggml-cuda.dll'
      Devices = $nvidiaDevices
    }
  }

  $amdDevices = @(Get-AmdDevices)
  if ($amdDevices.Count -gt 0) {
    return [pscustomobject]@{
      Backend = 'vulkan'
      DisplayName = 'AMD Vulkan'
      Asset = 'whooptido-whisper-runtime-windows-x64-vulkan.zip'
      ExpectedDll = 'ggml-vulkan.dll'
      Devices = $amdDevices
    }
  }

  Write-Fail "No supported ASR accelerator detected. Word-for-Word captions require NVIDIA CUDA, AMD Vulkan, or Apple Silicon Metal; CPU-only processing is not supported."
}

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

# --- Download accelerated whisper.cpp runtime ---
$RuntimeSelection = Select-WhisperRuntime
$WhisperRuntimeAsset = $RuntimeSelection.Asset
$WhisperRuntimeUrl = "https://github.com/$Repo/releases/latest/download/$WhisperRuntimeAsset"

Write-Step "Selected $($RuntimeSelection.DisplayName) runtime for: $($RuntimeSelection.Devices -join ', ')"
Write-Step "Downloading accelerated whisper.cpp runtime..."

$RuntimeDir = Join-Path $InstallDir "whisper"
$RuntimeZip = Join-Path $env:TEMP $WhisperRuntimeAsset
$RuntimeExtract = Join-Path $env:TEMP "whooptido-whisper-runtime-windows-x64-$($RuntimeSelection.Backend)"
$StaleRuntimeDirs = @(
  (Join-Path $InstallDir "whisper"),
  (Join-Path $InstallDir "whisper-cuda"),
  (Join-Path $InstallDir "whisper-vulkan")
)

try {
  if (Test-Path -LiteralPath $RuntimeExtract) {
    Remove-Item -LiteralPath $RuntimeExtract -Recurse -Force
  }
  foreach ($StaleRuntimeDir in $StaleRuntimeDirs) {
    if (Test-Path -LiteralPath $StaleRuntimeDir) {
      Remove-Item -LiteralPath $StaleRuntimeDir -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  Invoke-WebRequest -Uri $WhisperRuntimeUrl -OutFile $RuntimeZip -UseBasicParsing
  Expand-Archive -Path $RuntimeZip -DestinationPath $RuntimeExtract -Force

  $RuntimeSource = $RuntimeExtract
  $UpstreamReleaseDir = Join-Path $RuntimeExtract "Release"
  if (Test-Path -LiteralPath $UpstreamReleaseDir) {
    $RuntimeSource = $UpstreamReleaseDir
  }

  Copy-Item -Path (Join-Path $RuntimeSource "*") -Destination $RuntimeDir -Recurse -Force

  $WhisperCliPath = Join-Path $RuntimeDir "whisper-cli.exe"
  if (-not (Test-Path -LiteralPath $WhisperCliPath)) {
    Write-Fail "whisper-cli.exe was not found after runtime installation."
  }

  $ExpectedRuntimeDllPath = Join-Path $RuntimeDir $RuntimeSelection.ExpectedDll
  if (-not (Test-Path -LiteralPath $ExpectedRuntimeDllPath)) {
    Write-Fail "Selected runtime did not include $($RuntimeSelection.ExpectedDll); refusing to install a non-accelerated ASR runtime."
  }

  $ProbeOutput = & $WhisperCliPath -h 2>&1
  $ProbeExit = $LASTEXITCODE
  if ($ProbeExit -ne 0) {
    $ProbeText = ($ProbeOutput | Out-String).Trim()
    Write-Fail "whisper-cli.exe failed its startup check (exit $ProbeExit). $ProbeText"
  }

  Write-Ok "Accelerated Whisper runtime installed: $RuntimeDir ($($RuntimeSelection.DisplayName))"
} catch {
  Write-Fail "Whisper runtime download failed: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $RuntimeZip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $RuntimeExtract -Recurse -Force -ErrorAction SilentlyContinue
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
    "chrome-extension://$PrimaryExtensionId/",
    "chrome-extension://$LegacyExtensionId/"
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
Write-Host "  Whisper:  $RuntimeDir"
Write-Host "  Manifest: $ManifestPath"
Write-Host "  Registry: $RegPath"
Write-Host ""
Write-Host "  Restart Chrome, then enable Word-for-Word Captions"
Write-Host "  in the Whooptido extension settings."
Write-Host ""
Write-Host "  To uninstall:"
Write-Host "    irm https://raw.githubusercontent.com/$Repo/main/scripts/uninstall.ps1 | iex"
Write-Host ""
