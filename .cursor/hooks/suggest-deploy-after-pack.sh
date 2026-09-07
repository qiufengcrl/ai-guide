#!/usr/bin/env bash
# After a successful pack, remind agent/user to deploy plugin.zip to TREK.
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.command // empty')
exit_code=$(echo "$input" | jq -r '.exitCode // .exit_code // empty')

# Only nudge when pack actually succeeded.
if [[ -n "$exit_code" && "$exit_code" != "0" ]]; then
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/trek-plugin.json"
version="unknown"
plugin_id="ai-guide"

if [[ -f "$MANIFEST" ]]; then
  version=$(jq -r '.version // "unknown"' "$MANIFEST")
  plugin_id=$(jq -r '.id // "ai-guide"' "$MANIFEST")
fi

host="${TREK_HOST:-47.98.168.226}"
user="${TREK_USER:-root}"
deploy_cmd="TREK_HOST=${host} TREK_USER=${user} ./scripts/deploy-production.sh"
restart_hint="ssh ${user}@${host} 'cd /opt/trek && docker compose restart trek'"

jq -n \
  --arg plugin_id "$plugin_id" \
  --arg version "$version" \
  --arg deploy_cmd "$deploy_cmd" \
  --arg restart_hint "$restart_hint" \
  --arg command "$command" \
  '{
    "additional_context": ("插件打包已完成（" + $plugin_id + " v" + $version + "，命令: " + $command + "）。\n\n下一步发布到 TREK 服务器:\n  " + $deploy_cmd + "\n\n说明:\n- 上传 plugin.zip 并解压到 /opt/trek/data/plugins/ai-guide\n- 需要本机 SSH 免密登录；可用 TREK_HOST、TREK_USER、TREK_PLUGIN_DIR 覆盖\n- 若未热更新，部署后执行:\n  " + $restart_hint)
  }'

exit 0
