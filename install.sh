#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
# Resolve through asdf shims to the real binary (launchd has no shell PATH)
NODE_BIN="$(asdf which node 2>/dev/null || which node)"
PLIST_LABEL="com.claudebridge.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
NATIVE_HOST_NAME="com.claudebridge.host"
CHROME_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BRAVE_HOSTS_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"

# ── 1. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing npm dependencies..."
cd "$HOST_DIR" && npm install && cd "$SCRIPT_DIR"

# ── 2. Make scripts executable ────────────────────────────────────────────────
chmod +x "$HOST_DIR/daemon.js"
chmod +x "$HOST_DIR/native-host.js"

# ── 3. Get extension ID from user ─────────────────────────────────────────────
if [ -z "$EXTENSION_ID" ]; then
  echo ""
  echo "Load the extension in Chrome (chrome://extensions → Load unpacked → select extension/)"
  echo "then paste your extension ID here:"
  read -r EXTENSION_ID
fi

# ── 4. Write native messaging host manifest ───────────────────────────────────
mkdir -p "$CHROME_HOSTS_DIR"
cat > "$CHROME_HOSTS_DIR/$NATIVE_HOST_NAME.json" <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "claude-bridge native host relay",
  "path": "$NODE_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

# Wrap the node invocation so Chrome passes the script path as an argument
# Chrome's native messaging protocol runs the "path" binary directly — we use
# a small wrapper that Node can exec.
WRAPPER="$HOST_DIR/run-native-host.sh"
cat > "$WRAPPER" <<WRAPPER
#!/bin/bash
exec "$NODE_BIN" "$HOST_DIR/native-host.js" "\$@"
WRAPPER
chmod +x "$WRAPPER"

# Update manifest to point at wrapper instead of node directly
cat > "$CHROME_HOSTS_DIR/$NATIVE_HOST_NAME.json" <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "claude-bridge native host relay",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "→ Chrome native host manifest written to $CHROME_HOSTS_DIR/$NATIVE_HOST_NAME.json"

# Brave support (optional)
if [ -d "$(dirname "$BRAVE_HOSTS_DIR")" ]; then
  mkdir -p "$BRAVE_HOSTS_DIR"
  cp "$CHROME_HOSTS_DIR/$NATIVE_HOST_NAME.json" "$BRAVE_HOSTS_DIR/"
  echo "→ Also wrote Brave manifest"
fi

# ── 5. Write launchd plist ────────────────────────────────────────────────────
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

# ── 6. Load the daemon ────────────────────────────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"
echo "→ Daemon loaded via launchd (auto-starts on login)"

# ── 7. Print Claude Code config ───────────────────────────────────────────────
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
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
