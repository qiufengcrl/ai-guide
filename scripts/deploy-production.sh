#!/usr/bin/env bash
set -euo pipefail

# Deploy ai-guide plugin to self-hosted TREK.
# Usage:
#   TREK_HOST=47.98.168.226 TREK_USER=root ./scripts/deploy-production.sh
# Optional: TREK_PLUGIN_DIR=/opt/trek/data/plugins/ai-guide

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${TREK_HOST:-47.98.168.226}"
USER="${TREK_USER:-root}"
PLUGIN_DIR="${TREK_PLUGIN_DIR:-/opt/trek/data/plugins/ai-guide}"
ZIP="$ROOT/plugin.zip"

if [[ ! -f "$ZIP" ]]; then
  (cd "$ROOT" && npm run pack)
fi

echo "Deploying $(basename "$ZIP") to ${USER}@${HOST}:${PLUGIN_DIR}"
ssh "${USER}@${HOST}" "mkdir -p '${PLUGIN_DIR}'"
scp "$ZIP" "${USER}@${HOST}:/tmp/ai-guide-plugin.zip"
ssh "${USER}@${HOST}" bash -s <<EOF
set -euo pipefail
TMP=\$(mktemp -d)
unzip -oq /tmp/ai-guide-plugin.zip -d "\$TMP"
rsync -a --delete "\$TMP/" "${PLUGIN_DIR}/"
rm -rf "\$TMP" /tmp/ai-guide-plugin.zip
echo "Deployed to ${PLUGIN_DIR}"
EOF

echo "Restart TREK if plugins are not hot-reloaded:"
echo "  ssh ${USER}@${HOST} 'cd /opt/trek && docker compose restart trek'"
