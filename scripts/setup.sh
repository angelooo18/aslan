#!/usr/bin/env bash
set -euo pipefail

ASLAN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

echo "ASLAN setup: $ASLAN_DIR"

command -v pi >/dev/null 2>&1 || {
  echo "error: pi is not in PATH. Install pi.dev first: https://pi.dev" >&2
  exit 1
}
command -v npx >/dev/null 2>&1 || {
  echo "error: npx is not in PATH (Node.js is required by pi)." >&2
  exit 1
}
if ! command -v tmux >/dev/null 2>&1; then
  echo "warning: tmux is not installed; subagents need it."
fi

# When ASLAN was cloned instead of installed by pi, make sure production deps exist.
if [ ! -d "$ASLAN_DIR/node_modules/playwright" ]; then
  echo "Installing ASLAN npm dependencies..."
  (cd "$ASLAN_DIR" && npm install --omit=dev --no-audit --no-fund)
fi

echo "Installing Playwright Chromium (browser tools)..."
(cd "$ASLAN_DIR" && npx playwright install chromium)

echo "Installing Puppeteer Chrome (Mermaid rendering)..."
(cd "$ASLAN_DIR" && npx puppeteer browsers install chrome) || \
  echo "warning: Puppeteer browser install failed; Mermaid may fall back to an existing Chrome."

if pi list 2>/dev/null | grep -Eq 'pi-interactive-subagents|pi-observational-memory|angelooo18/mermaid'; then
  echo "warning: standalone mermaid/subagents/observational-memory packages are still installed."
  echo "         Remove them from ~/.pi/agent/settings.json so ASLAN does not register twice."
fi

mkdir -p "$AGENT_DIR"

if [ ! -f "$AGENT_DIR/AGENTS.md" ]; then
  cp "$ASLAN_DIR/AGENTS.md" "$AGENT_DIR/AGENTS.md"
  echo "installed AGENTS.md"
else
  echo "kept existing AGENTS.md (reference: $ASLAN_DIR/AGENTS.md)"
fi

for file in permissions.json subagent-limits.json; do
  if [ ! -f "$AGENT_DIR/$file" ]; then
    cp "$ASLAN_DIR/config/$file" "$AGENT_DIR/$file"
    echo "installed $file"
  else
    echo "kept existing $file"
  fi
done

node "$ASLAN_DIR/scripts/merge-settings.mjs" \
  "$AGENT_DIR/settings.json" \
  "$ASLAN_DIR/config/settings.example.json"

cat <<'EOF'

ASLAN is ready. Next:
  1. Run: pi
  2. Log in to DeepSeek: /login    (or export DEEPSEEK_API_KEY=...)
  3. Run: /reload
  4. Try: /subagent scout "map this repository"
  5. Try: /om on   and   /om:status

The agent definitions are bundled in ASLAN/agents; no global copy is required.
EOF
