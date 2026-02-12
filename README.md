# Whooptido ASR Captions

Local speech recognition for word-for-word captions in the [Whooptido](https://whooptido.app) browser extension.

## What Is This?

The ASR Captions companion app runs a local speech recognition engine ([Whisper](https://github.com/ggerganov/whisper.cpp)) on your computer to generate word-level timed captions for videos. All processing happens locally — no audio is sent to any server.

## Requirements

- The [Whooptido Chrome Extension](https://whooptido.app)
- 4 GB+ RAM (8 GB+ recommended for larger models)

## Installation

The installer downloads the binary and registers the Chrome native messaging host automatically.

### macOS / Linux

Open **Terminal** and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.sh | bash
```

### Windows

Open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.ps1 | iex
```

### After Installing

1. **Restart Chrome** (close all Chrome windows and reopen)
2. Open the Whooptido extension settings
3. The companion app should be detected automatically
4. Enable **Word-for-Word Captions**

## Uninstallation

### macOS / Linux

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
