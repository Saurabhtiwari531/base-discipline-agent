#!/usr/bin/env bash
# Installs the agent as a macOS LaunchAgent: auto-start at login, auto-restart
# on crash (KeepAlive), logs to logs/agent.log. Run once:  bash scripts/install-service.sh
# Manage:  launchctl kickstart -k gui/$UID/com.tradecoach.agent   (force restart)
#          launchctl bootout gui/$UID/com.tradecoach.agent        (stop + uninstall)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.tradecoach.agent.plist"
LABEL="com.tradecoach.agent"

mkdir -p "$HOME/Library/LaunchAgents" logs

# launchd has no login PATH — resolve absolute paths at install time.
NODE_BIN="$(command -v node)"
TSX_CLI="${PROJECT_DIR}/node_modules/tsx/dist/cli.mjs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-is</string>
    <string>${NODE_BIN}</string>
    <string>${TSX_CLI}</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${PROJECT_DIR}/logs/agent.log</string>
  <key>StandardErrorPath</key><string>${PROJECT_DIR}/logs/agent.log</string>
</dict>
</plist>
EOF

# Stop any manually-started instance so the service owns the XMTP db alone.
pkill -f "tsx src/index.ts" 2>/dev/null || true
sleep 3

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/${LABEL}"

echo "installed: ${PLIST}"
launchctl print "gui/$(id -u)/${LABEL}" | grep -E "state|pid" | head -3
