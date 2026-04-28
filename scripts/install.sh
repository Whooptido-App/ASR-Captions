#!/bin/bash
# Whooptido ASR Captions — Installer for Apple Silicon macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/install.sh | bash
#
# What this does:
# 1. Detects supported accelerated platforms (Apple Silicon macOS)
# 2. Downloads the correct binary from GitHub Releases
# 3. Installs it to ~/.whooptido/
# 4. Registers the Chrome native messaging host
# 5. Sets correct permissions

set -euo pipefail

# --- Configuration ---
REPO="Whooptido-App/ASR-Captions"
HOST_NAME="com.whooptido.companion"
INSTALL_DIR="$HOME/.whooptido"
BINARY_NAME="whooptido-asr-captions"
# Extension IDs allowed to connect to the native host.
# pjac... is the current packaged/unpacked Whooptido ID; iab... is retained for older beta installs.
PRIMARY_EXTENSION_ID="pjacfbdlalhafifgdoddiojjjeabkhcg"
LEGACY_EXTENSION_ID="iabpcgbkbkkeokigbgogggaoejnbkikn"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# --- Detect Platform ---
detect_platform() {
  local os arch asset

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64) asset="whooptido-asr-captions-macos-arm" ;;
        x86_64) fail "Unsupported ASR platform: Intel Mac would use CPU-only processing. Whooptido ASR requires Apple Silicon Metal." ;;
        *) fail "Unsupported macOS architecture: $arch. Whooptido ASR requires Apple Silicon Metal." ;;
      esac
      ;;
    Linux)
      fail "Unsupported ASR platform: the Linux installer does not yet package NVIDIA CUDA or AMD Vulkan runtimes, and CPU-only processing is not supported."
      ;;
    *)
      fail "Unsupported OS: $os (use install.ps1 for Windows)"
      ;;
  esac

  echo "$asset"
}

# --- Get native messaging hosts directory ---
get_nm_dir() {
  local os="$(uname -s)"
  case "$os" in
    Darwin)
      echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      ;;
  esac
}

# --- Main ---
main() {
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   Whooptido ASR Captions — Installer     ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
  echo ""

  # Detect platform
  local asset
  asset="$(detect_platform)"
  info "Detected platform: $asset"

  # Get latest release version
  info "Fetching latest release..."
  local release_url="https://api.github.com/repos/$REPO/releases/latest"
  local tag_name
  tag_name="$(curl -fsSL "$release_url" | grep '"tag_name"' | head -1 | cut -d'"' -f4)" || true

  if [ -z "$tag_name" ]; then
    warn "Could not determine latest version, using 'latest'"
    tag_name="latest"
  else
    info "Latest version: $tag_name"
  fi

  # Download binary
  local download_url="https://github.com/$REPO/releases/latest/download/$asset"
  info "Downloading $asset..."

  mkdir -p "$INSTALL_DIR"
  curl -fSL --progress-bar -o "$INSTALL_DIR/$BINARY_NAME" "$download_url" \
    || fail "Download failed. Check https://github.com/$REPO/releases for available assets."

  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  ok "Binary installed: $INSTALL_DIR/$BINARY_NAME"

  # Create native messaging host manifest
  local nm_dir
  nm_dir="$(get_nm_dir)"
  mkdir -p "$nm_dir"

  local manifest_path="$nm_dir/$HOST_NAME.json"
  cat > "$manifest_path" << EOF
{
  "name": "$HOST_NAME",
  "description": "Whooptido ASR Captions Companion",
  "path": "$INSTALL_DIR/$BINARY_NAME",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$PRIMARY_EXTENSION_ID/",
    "chrome-extension://$LEGACY_EXTENSION_ID/"
  ]
}
EOF

  ok "Native messaging host registered: $manifest_path"

  # Verify installation
  echo ""
  if "$INSTALL_DIR/$BINARY_NAME" --version 2>/dev/null; then
    ok "Installation verified!"
  else
    ok "Binary installed (version check not supported)"
  fi

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   Installation complete!                 ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
  echo ""
  echo "  Binary:   $INSTALL_DIR/$BINARY_NAME"
  echo "  Manifest: $manifest_path"
  echo ""
  echo "  Restart Chrome, then enable Word-for-Word Captions"
  echo "  in the Whooptido extension settings."
  echo ""
  echo "  To uninstall:"
  echo "    curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/uninstall.sh | bash"
  echo ""
}

main "$@"
