# claude-bridge

A Chrome extension + native host that exposes your [Claude Code](https://claude.ai/code) cloud sessions as MCP tools — so any local agent can list sessions, read their state, inject prompts, create PRs, and more, all programmatically.

## The Problem

Claude Code cloud sessions run in the browser with no public API. You can start one, but you can't know when it's finished, read its state, or send a follow-up prompt without manually opening a tab. claude-bridge fills that gap.

## Architecture

```
Local agent (Claude Code / any MCP client)
    │
    │  MCP over HTTP (port 7878)
    ▼
Daemon (Node.js, always running via launchd/systemd)
    │
    │  Unix socket → native messaging
    ▼
Chrome Extension (background service worker)
    │
    │  chrome.tabs messaging
    ▼
Content Script (injected into claude.ai)
    │
    │  DOM + internal API calls
    ▼
claude.ai session
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `claude_sessions_list` | List all sessions visible in the sidebar |
| `claude_session_get_state` | Get state, branch info, CI status, model, and usage % |
| `claude_session_inject` | Submit a prompt to a session |
| `claude_session_create` | Open a new session with optional model, effort, and initial prompt |
| `claude_session_archive` | Archive a session |
| `claude_session_create_pr` | Click "Create PR" for a session with an open branch |
| `claude_session_set_ci_options` | Toggle auto-fix CI and auto-merge checkboxes |
| `claude_session_get_transcript` | Read the full conversation transcript |

Session state values: `running`, `ready`, `merged`, `pr_open`, `pr_closed`

## Requirements

- **macOS or Linux** — the daemon runs via launchd on macOS or systemd on Linux
- **Chrome, Chromium, or Brave**
- **Node.js** — via [asdf](https://asdf-vm.com/) or a system install
- **sudo** on Linux — required to install the systemd service

## Installation

**1. Clone the repo**

```bash
git clone https://github.com/pirateandfox/claude-bridge.git
cd claude-bridge
```

**2. Load the extension in Chrome for development**

- Go to `chrome://extensions`
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked** → select the `extension/` folder
- Copy the **Extension ID** shown on the card (you'll need it in step 3)

**3. Run the install script**

```bash
./install.sh
```

The script will prompt you for the extension ID, then:
- Installs npm dependencies
- Registers the native messaging host with detected browser profiles
- Writes and loads a launchd plist on macOS, or a systemd service on Linux

**4. Connect Claude Code**

```bash
claude mcp add claude-bridge http://127.0.0.1:7878/mcp
```

Or add it manually to `~/.claude.json`:

```json
"mcpServers": {
  "claude-bridge": {
    "url": "http://127.0.0.1:7878/mcp"
  }
}
```

**5. Verify**

```bash
curl http://127.0.0.1:7878/health
# → {"ok":true,"chrome":true}
```

`"chrome": false` means the extension isn't connected yet — make sure the extension is loaded and a claude.ai tab is open.

## Usage

Once installed, the MCP tools are available to any agent connected to `http://127.0.0.1:7878/mcp`. Example workflow:

```
1. claude_sessions_list          → get session IDs
2. claude_session_get_state      → check if running/ready
3. claude_session_inject         → send a follow-up prompt
4. claude_session_get_state      → poll until state returns to "ready"
5. claude_session_get_transcript → read the result
```

## Logs & Debugging

```bash
tail -f /tmp/claude-bridge.log    # daemon logs
```

To restart the daemon manually:

macOS:

```bash
launchctl unload  ~/Library/LaunchAgents/com.claudebridge.daemon.plist
launchctl load    ~/Library/LaunchAgents/com.claudebridge.daemon.plist
```

Linux:

```bash
sudo systemctl restart claude-bridge.service
```

## Linux Agent Nodes

On a headless Linux box, Chrome must run inside the virtual display with the extension loaded and at least one `claude.ai` tab open for `/health` to report `"chrome": true`. The daemon itself has no display dependency, but the end-to-end bridge does.

Run the daemon as the same user that owns the Chrome profile, for example
`ansible` on a Qalatra fleet node. Native messaging hosts are spawned by Chrome
as that user, and the manifest must live in that user's normal browser profile
under `~/.config/google-chrome/NativeMessagingHosts/`.

Fleet nodes use the signed `.crx`, not an unpacked extension. The CRX signing
key determines the stable extension ID
`ngcgcpjkgflmonjaoaclipefffngbfhd`; the matching public key is safe to commit in
`extension/manifest.json`. The native-host manifest must continue to list that
ID in `allowed_origins`. Increasing the manifest version does not change the ID
as long as every release is signed with the same private key.

## Updating

### Fleet releases (signed `.crx`)

Fleet Chrome runs normally, without remote-debugging or unsafe-extension flags.
Tagged releases package the extension with the repository's protected signing
key and publish `claude-bridge.crx` plus its checksum. The private key is stored
as the `EXTENSION_SIGNING_KEY_B64` GitHub Actions repository secret; it is never
committed or installed on fleet nodes. GitHub secrets are write-only after they
are saved, so maintain an independent encrypted backup of this key in a secure
vault. The verified recovery copy is stored in the Pirate & Fox 1Password
Employee vault as `Claude Bridge CRX Signing Key`. The release workflow decodes
the GitHub copy only into the ephemeral runner's temporary directory.

The fleet playbook installs the resulting package through Chrome's supported
Linux external-extension mechanism.

See the [releases page](../../releases) for packaged `.crx` files.

To create a release, increment `extension/manifest.json`'s version, commit and
push it, then push the matching tag. Always use the existing signing key. For
example:

```bash
git tag -a v0.1.2 -m "Claude Bridge v0.1.2"
git push origin develop v0.1.2
```

After GitHub publishes the release, update Qalatra Fleet's pinned CRX version,
release URL, and SHA-256 checksum. Do not change the extension ID unless the
signing key was intentionally rotated.

For a local package test, keep the private key outside the repository:

```bash
scripts/package-extension.sh /secure/path/extension.pem dist/claude-bridge.crx
```

### Manual updates

```bash
git pull
./install.sh   # re-registers the native host if paths changed
```

Then reload the extension at `chrome://extensions`.

## Known Limitations

- **Windows not supported** — Windows would require registry-based native-host registration and a Windows service wrapper.
- **claude.ai DOM changes** — Anthropic can rename selectors at any time. Selectors live in `extension/content.js` in a single `SEL` object so updates are one-line fixes.
- **One claude.ai tab required** — the extension needs at least one claude.ai tab open to relay commands. Opening claude.ai in the background is enough.
- **Personal use** — Anthropic's consumer ToS restricts automated browser access. This tool is fine for personal agentic workflows. If Anthropic releases an official cloud sessions API, the MCP interface stays identical and only the DOM layer needs to be replaced.

## Contributing

Bug reports and PRs welcome. The most useful contributions are updated selectors when claude.ai's DOM changes — check `extension/content.js:SEL` first.
