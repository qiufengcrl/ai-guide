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
python3 - << 'PY'
import json, os, shutil, tempfile, time, zipfile
plugin_dir = "${PLUGIN_DIR}"
os.makedirs(plugin_dir, exist_ok=True)
bak = plugin_dir + ".bak.deploy.%d" % int(time.time())
if os.path.isdir(plugin_dir) and os.listdir(plugin_dir):
    shutil.copytree(plugin_dir, bak)
tmp = tempfile.mkdtemp()
with zipfile.ZipFile("/tmp/ai-guide-plugin.zip") as z:
    z.extractall(tmp)
if os.path.isdir(plugin_dir):
    shutil.rmtree(plugin_dir)
shutil.copytree(tmp, plugin_dir)
shutil.rmtree(tmp)
os.remove("/tmp/ai-guide-plugin.zip")
man = json.load(open(os.path.join(plugin_dir, "trek-plugin.json")))
print("Deployed", man.get("id"), man.get("version"), "to", plugin_dir)
PY
# Coolify names the container; compose service is "app".
if docker ps --format '{{.Names}}' | grep -qx trek; then
  docker restart trek
else
  docker ps -q | while read -r id; do
    mounts=\$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "\$id")
    case "\$mounts" in
      */opt/trek/data*) docker restart "\$id"; break ;;
    esac
  done
fi
EOF
