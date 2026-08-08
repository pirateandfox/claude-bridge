#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac

# Resolve through asdf shims when available so service managers do not depend on
# an interactive shell PATH, then fall back to the first node on PATH.
NODE_BIN=""
if command -v asdf >/dev/null 2>&1; then
  NODE_BIN="$(asdf which node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "Node.js was not found. Install Node.js, then re-run ./install.sh"
  exit 1
fi

PLIST_LABEL="com.claudebridge.daemon"
NATIVE_HOST_NAME="com.claudebridge.host"
WRAPPER="$HOST_DIR/run-native-host.sh"

if [ "$OS" = "macos" ]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
  CHROME_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  BRAVE_HOSTS_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
else
  CHROME_HOSTS_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROMIUM_HOSTS_DIR="$HOME/.config/chromium/NativeMessagingHosts"
  BRAVE_HOSTS_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
fi

# ── 1. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing npm dependencies..."
(cd "$HOST_DIR" && npm install)

# ── 2. Make scripts executable ────────────────────────────────────────────────
chmod +x "$HOST_DIR/daemon.js"
chmod +x "$HOST_DIR/native-host.js"

# ── 3. Determine the extension ID ─────────────────────────────────────────────
# extension/manifest.json carries a "key", so the extension ID is FIXED and
# derivable — it is the SHA-256 of the decoded key, first 16 bytes, hex mapped
# 0-f → a-p. Chrome uses that same ID whether the extension is loaded unpacked
# or installed from the signed .crx.
#
# This used to prompt unconditionally, which quietly broke every install done
# before the key was added (2026-08-08): the manifest kept allowing the old
# pre-key dev ID, Chrome refused the native-messaging connection, and the bridge
# reported "Chrome not connected" forever with no hint as to why. Derive it, and
# only fall back to asking.
derive_extension_id() {
  python3 - "$SCRIPT_DIR/extension/manifest.json" <<'PY' 2>/dev/null
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1])).get("key")
if not key:
    raise SystemExit(1)
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
PY
}

if [ -z "$EXTENSION_ID" ]; then
  EXTENSION_ID="$(derive_extension_id || true)"
fi

if [ -n "$EXTENSION_ID" ]; then
  echo "→ Extension ID: $EXTENSION_ID"
else
  echo ""
  echo "Could not derive the extension ID from extension/manifest.json (no \"key\"?)."
  echo "Load the extension in Chrome (chrome://extensions → Load unpacked → select extension/)"
  echo "then paste your extension ID here:"
  read -r EXTENSION_ID
fi

# ── 4. Generate native host wrapper ───────────────────────────────────────────
cat > "$WRAPPER" <<WRAPPER
#!/bin/bash
exec "$NODE_BIN" "$HOST_DIR/native-host.js" "\$@"
WRAPPER
chmod +x "$WRAPPER"

# ── 5. Write native messaging host manifests ─────────────────────────────────
MANIFEST_COUNT=0

write_manifest() {
  local browser="$1"
  local dir="$2"
  local browser_config_dir
  browser_config_dir="$(dirname "$dir")"

  if [ ! -d "$browser_config_dir" ]; then
    echo "→ Skipping $browser manifest; $browser_config_dir does not exist"
    return 0
  fi

  mkdir -p "$dir"
  cat > "$dir/$NATIVE_HOST_NAME.json" <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "claude-bridge native host relay",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

  MANIFEST_COUNT=$((MANIFEST_COUNT + 1))
  echo "→ $browser native host manifest written to $dir/$NATIVE_HOST_NAME.json"
}

if [ "$OS" = "macos" ]; then
  write_manifest "Chrome" "$CHROME_HOSTS_DIR"
  write_manifest "Brave" "$BRAVE_HOSTS_DIR"
else
  write_manifest "Chrome" "$CHROME_HOSTS_DIR"
  write_manifest "Chromium" "$CHROMIUM_HOSTS_DIR"
  write_manifest "Brave" "$BRAVE_HOSTS_DIR"
fi

if [ "$MANIFEST_COUNT" -eq 0 ]; then
  echo "→ Warning: no browser profile directories were found, so no native host manifest was written"
fi

# ── 6. Configure service manager ─────────────────────────────────────────────
if [ "$OS" = "macos" ]; then
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>         <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HOST_DIR/daemon.js</string>
  </array>
  <key>RunAtLoad</key>     <true/>
  <key>KeepAlive</key>     <true/>
  <key>StandardOutPath</key> <string>/tmp/claude-bridge.log</string>
  <key>StandardErrorPath</key> <string>/tmp/claude-bridge.log</string>
  <key>WorkingDirectory</key> <string>$HOST_DIR</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "→ Daemon loaded via launchd (auto-starts on login)"
else
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl was not found. claude-bridge requires systemd service setup on Linux."
    exit 1
  fi

  SERVICE_USER="${SUDO_USER:-${USER:-$(id -un)}}"
  SERVICE_PATH="/etc/systemd/system/claude-bridge.service"

  sudo tee "$SERVICE_PATH" > /dev/null <<EOF
[Unit]
Description=claude-bridge daemon (MCP server + native-host relay)
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $HOST_DIR/daemon.js
Restart=always
RestartSec=2
User=$SERVICE_USER
Environment=NODE_ENV=production
WorkingDirectory=$HOST_DIR
StandardOutput=append:/tmp/claude-bridge.log
StandardError=append:/tmp/claude-bridge.log

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now claude-bridge.service
  echo "→ Daemon loaded via systemd (auto-starts on boot as $SERVICE_USER)"
fi

# ── 7. Print Claude Code config and operational help ─────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Add this to your ~/.claude.json mcpServers section:"
echo ""
echo '  "claude-bridge": {'
echo '    "url": "http://127.0.0.1:7878/mcp"'
echo '  }'
echo ""
echo "Or run:  claude mcp add claude-bridge http://127.0.0.1:7878/mcp"
echo ""
echo "Health check: curl http://127.0.0.1:7878/health"
echo "Logs:         tail -f /tmp/claude-bridge.log"
if [ "$OS" = "macos" ]; then
  echo "Restart:      launchctl unload ~/Library/LaunchAgents/$PLIST_LABEL.plist && launchctl load ~/Library/LaunchAgents/$PLIST_LABEL.plist"
else
  echo "Restart:      sudo systemctl restart claude-bridge.service"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
