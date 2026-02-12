#!/bin/bash
# Whooptido ASR Captions — Uninstaller for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/uninstall.sh | bash

set -euo pipefail

HOST_NAME="com.whooptido.companion"
INSTALL_DIR="$HOME/.whooptido"
BINARY_NAME="whooptido-asr-captions"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }

get_nm_dir() {
  local os="$(uname -s)"
  case "$os" in
    Darwin) echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    Linux)  echo "$HOME/.config/google-chrome/NativeMessagingHosts" ;;
  esac
}

main() {
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════╗${NC}"
  echo -e "${RED}║   Whooptido ASR Captions — Uninstaller   ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════╝${NC}"
  echo ""

  local nm_dir
  nm_dir="$(get_nm_dir)"
  local manifest_path="$nm_dir/$HOST_NAME.json"

  # Remove native messaging host manifest
  if [ -f "$manifest_path" ]; then
    rm "$manifest_path"
    ok "Removed native messaging manifest: $manifest_path"
  else
    info "No manifest found at: $manifest_path"
  fi

  # Remove binary
  if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
    rm "$INSTALL_DIR/$BINARY_NAME"
    ok "Removed binary: $INSTALL_DIR/$BINARY_NAME"
  else
    info "No binary found at: $INSTALL_DIR/$BINARY_NAME"
  fi

  # Remove install directory if empty
  if [ -d "$INSTALL_DIR" ] && [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    rmdir "$INSTALL_DIR"
    ok "Removed empty directory: $INSTALL_DIR"
  fi

  echo ""
  ok "Whooptido ASR Captions has been uninstalled."
  echo "  Restart Chrome for changes to take effect."
  echo ""
}

main "$@"
