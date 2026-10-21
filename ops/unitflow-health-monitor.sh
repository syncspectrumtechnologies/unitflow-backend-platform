#!/usr/bin/env bash
set -Eeuo pipefail

URLS=(
  "https://unitflow.in"
  "https://api.unitflow.in/ready"
  "https://core.unitflow.in/dashboard"
  "https://core-api.unitflow.in/ready"
)

failed=0
messages=()
for url in "${URLS[@]}"; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 "$url" || true)"
  if [[ "$code" != "200" ]]; then
    logger -t unitflow-monitor "Health check failed url=${url} status=${code:-network_error}"
    messages+=("Endpoint failed: ${url} (${code:-network_error})")
    failed=1
  fi
done

for process in unitflow-backend-platform unitflow-backend-core unitflow-frontend-platform unitflow-frontend-core; do
  if ! pm2 pid "$process" | grep -Eq '^[1-9][0-9]*$'; then
    logger -t unitflow-monitor "PM2 process unavailable process=${process}"
    messages+=("PM2 process unavailable: ${process}")
    failed=1
  fi
done

if (( failed )); then
  node "${UNITFLOW_PLATFORM_DIR:-/var/www/unitflow-backend-platform/current}/ops/send-monitor-alert.js" "${messages[*]}" || true
  exit 1
fi
echo "UnitFlow health checks passed"
