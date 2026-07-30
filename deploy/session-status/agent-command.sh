#!/usr/bin/env bash
set -euo pipefail

status_dir="${SESSION_STATUS_OUTPUT_DIR:-${HOME}/Library/Application Support/Buzz/session-status}"
status_file="${status_dir}/status.json"

if [[ ! -r "${status_file}" ]]; then
  printf 'Missing sanitized status index: %s\n' "${status_file}" >&2
  exit 1
fi

exec docker run --rm -i \
  --read-only \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env BUZZ_PRIVATE_KEY \
  --env BUZZ_RELAY_URL \
  --env BUZZ_API_TOKEN \
  --env BUZZ_AUTH_TAG \
  --volume "${status_dir}:/status:ro" \
  --entrypoint node \
  buzz-session-status:local \
  /app/session-status-agent.mjs
