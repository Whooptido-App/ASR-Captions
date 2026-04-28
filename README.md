# Whooptido ASR Captions

Local speech recognition for word-for-word captions in the [Whooptido](https://whooptido.app) browser extension.

## What Is This?

The ASR Captions companion app runs a local speech recognition engine ([Whisper](https://github.com/ggerganov/whisper.cpp)) on your computer to generate word-level timed captions for videos. All processing happens locally — no audio is sent to any server.

## Requirements

- The [Whooptido Chrome Extension](https://whooptido.app)
- One supported local acceleration backend:
	- NVIDIA GPU on Windows using CUDA
	- AMD GPU on Windows using Vulkan
	- Apple Silicon Mac using Metal

CPU-only speech recognition is not supported for Word-for-Word Captions.

## Installation

The installer downloads the binary and registers the Chrome native messaging host automatically.

### macOS (Apple Silicon)

Open **Terminal** and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.sh | bash
```

### Windows

Open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.ps1 | iex
```

The Windows installer is Authenticode-signed. During early beta releases, Microsoft Defender SmartScreen may still show an "unrecognized app" prompt for a new installer hash while reputation builds. Download only from the official GitHub release, verify the publisher shown by Windows, and compare the SHA-256 in the release's `windows-signing-report.json` if you need extra confirmation.

Windows releases include accelerated whisper.cpp runtimes for NVIDIA CUDA and AMD Vulkan. The installer selects a runtime from detected hardware and refuses CPU-only installs.

### After Installing

1. **Restart Chrome** (close all Chrome windows and reopen)
2. Open the Whooptido extension settings
3. The companion app should be detected automatically
4. Enable **Word-for-Word Captions**

## Uninstallation

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/uninstall.sh | bash
```

### Windows

```powershell
irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/uninstall.ps1 | iex
```

## How It Works

1. The extension sends audio to the companion app via Chrome's [Native Messaging API](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
2. The companion app runs Whisper speech recognition locally
3. Word-level timestamps are sent back to the extension
4. The extension displays word-for-word captions in sync with the video

## Building from Source

```bash
git clone https://github.com/Whooptido-App/ASR-Captions.git
cd ASR-Captions
npm install
node native-host.js
```

To create a standalone binary:

```bash
npm install -g @yao-pkg/pkg
pkg native-host.js -t node20-macos-arm64  # adjust target as needed
```

## License

MIT
