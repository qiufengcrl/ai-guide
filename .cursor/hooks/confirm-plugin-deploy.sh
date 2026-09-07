#!/usr/bin/env bash
# Gate production deploy: ask before uploading plugin.zip to TREK server.
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.command // empty')

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/trek-plugin.json"

version="unknown"
plugin_id="ai-guide"
host="${TREK_HOST:-47.98.168.226}"
user="${TREK_USER:-root}"
plugin_dir="${TREK_PLUGIN_DIR:-/opt/trek/data/plugins/ai-guide}"

if [[ -f "$MANIFEST" ]]; then
  version=$(jq -r '.version // "unknown"' "$MANIFEST")
  plugin_id=$(jq -r '.id // "ai-guide"' "$MANIFEST")
fi

zip_path="$ROOT/plugin.zip"
zip_note="将先执行 npm run pack 生成 plugin.zip"
if [[ -f "$zip_path" ]]; then
  zip_note="将上传现有 plugin.zip（$(du -h "$zip_path" | awk '{print $1}')）"
fi

jq -n \
  --arg cmd "$command" \
  --arg version "$version" \
  --arg plugin_id "$plugin_id" \
  --arg host "$host" \
  --arg user "$user" \
  --arg plugin_dir "$plugin_dir" \
  --arg zip_note "$zip_note" \
  '{
    "permission": "ask",
    "user_message": ("确认发布插件到 TREK 服务器？\n\n插件: " + $plugin_id + " v" + $version + "\n目标: " + $user + "@" + $host + ":" + $plugin_dir + "\n" + $zip_note + "\n\n需要本机已配置 SSH 免密登录（TREK_HOST / TREK_USER 可用环境变量覆盖）。\n命令: " + $cmd),
    "agent_message": ("Production deploy to " + $user + "@" + $host + " for " + $plugin_id + " v" + $version + ". Wait for user approval before continuing.")
  }'

exit 0
