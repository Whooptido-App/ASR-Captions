# Whooptido ASR Captions

Local speech recognition for word-for-word captions in the [Whooptido](https://whooptido.app) browser extension.

## What Is This?

The ASR Captions companion app runs a local speech recognition engine ([Whisper](https://github.com/ggerganov/whisper.cpp)) on your computer to generate word-level timed captions for videos. All processing happens locally — no audio is sent to any server.

## Requirements

- The [Whooptido Chrome Extension](https://whooptido.app)
- 4 GB+ RAM (8 GB+ recommended for larger models)

## Installation

### macOS (Apple Silicon)

1. Download `whooptido-asr-captions-macos-arm.dmg` from [Releases](https://github.com/Whooptido-App/ASR-Captions/releases/latest)
2. Open the DMG and drag the app to Applications
3. Open the app once — macOS will ask for permission, click **Open**
4. Return to the Whooptido extension settings; it should detect the app

### macOS (Intel)

1. Download `whooptido-asr-captions-macos-intel.dmg` from [Releases](https://github.com/Whooptido-App/ASR-Captions/releases/latest)
2. Open the DMG and drag the app to Applications
3. Open the app once — macOS will ask for permission, click **Open**
4. Return to the Whooptido extension settings; it should detect the app

### Windows

1. Download `whooptido-asr-captions-windows-x64.exe` from [Releases](https://github.com/Whooptido-App/ASR-Captions/releases/latest)
2. Run the installer and follow the prompts
3. Return to the Whooptido extension settings; it should detect the app

### Linux

1. Download `whooptido-asr-captions-linux-x64.AppImage` from [Releases](https://github.com/Whooptido-App/ASR-Captions/releases/latest)
2. Make it executable: `chmod +x whooptido-asr-captions-linux-x64.AppImage`
3. Run it once to install the native messaging host
4. Return to the Whooptido extension settings; it should detect the app

## Uninstallation

### macOS

1. Delete the app from Applications
2. Remove the native messaging host config:
   ```
   rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.whooptido.companion.json
   ```

### Windows

1. Use **Add or Remove Programs** in Windows Settings
2. Search for "Whooptido" and uninstall

### Linux

1. Delete the AppImage file
2. Remove the native messaging host config:
   ```
   rm ~/.config/google-chrome/NativeMessagingHosts/com.whooptido.companion.json
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
