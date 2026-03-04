#!/bin/bash
# Whooptido ASR Captions — Uninstaller for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/Whooptido-App/ASR-Captions/main/scripts/uninstall.sh | bash

set -euo pipefail

HOST_NAME="com.whooptido.companion"
INSTALL_DIR="$HOME/.whooptido"
OLD_MODELS_DIR="$HOME/whisper-models"

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

get_system_nm_dir() {
  local os="$(uname -s)"
  case "$os" in
    Darwin) echo "/Library/Google/Chrome/NativeMessagingHosts" ;;
    Linux)  echo "/etc/opt/chrome/native-messaging-hosts" ;;
  esac
}

main() {
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════╗${NC}"
  echo -e "${RED}║   Whooptido ASR Captions — Uninstaller   ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════╝${NC}"
  echo ""

  # Remove user-level native messaging host manifest
  local nm_dir
  nm_dir="$(get_nm_dir)"
  local manifest_path="$nm_dir/$HOST_NAME.json"

  if [ -f "$manifest_path" ]; then
    rm "$manifest_path"
    ok "Removed native messaging manifest: $manifest_path"
  else
    info "No user manifest found at: $manifest_path"
  fi

  # Try removing system-level manifest (may need sudo)
  local sys_nm_dir
  sys_nm_dir="$(get_system_nm_dir)"
  local sys_manifest_path="$sys_nm_dir/$HOST_NAME.json"

  if [ -f "$sys_manifest_path" ]; then
    if rm "$sys_manifest_path" 2>/dev/null; then
      ok "Removed system manifest: $sys_manifest_path"
    else
      info "System manifest requires elevated permissions: $sys_manifest_path"
      if sudo rm "$sys_manifest_path" 2>/dev/null; then
        ok "Removed system manifest (with sudo): $sys_manifest_path"
      else
        info "Could not remove system manifest — remove manually if needed"
      fi
    fi
  fi

  # Remove entire ~/.whooptido/ directory (binary + models + all data)
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed Whooptido directory: $INSTALL_DIR"
  else
    info "No Whooptido directory found at: $INSTALL_DIR"
  fi

  # Remove legacy ~/whisper-models/ directory (from pre-1.1.0 installs)
  if [ -d "$OLD_MODELS_DIR" ]; then
    rm -rf "$OLD_MODELS_DIR"
    ok "Removed legacy models directory: $OLD_MODELS_DIR"
  fi

  # Clean up temp files
  local tmp_count=0
  for f in /tmp/whooptido-*; do
    [ -e "$f" ] || continue
    rm -rf "$f"
    tmp_count=$((tmp_count + 1))
  done
  if [ "$tmp_count" -gt 0 ]; then
    ok "Cleaned $tmp_count temp files"
  fi

  echo ""
  ok "Whooptido ASR Captions has been uninstalled."
  echo "  Restart Chrome for changes to take effect."
  echo ""
}

main "$@"
