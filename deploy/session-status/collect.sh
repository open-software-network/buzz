#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
output_dir="${SESSION_STATUS_OUTPUT_DIR:-${repo_root}/.session-status}"

mkdir -p "${output_dir}"
chmod 700 "${output_dir}"

if [[ "${SESSION_STATUS_SKIP_BUILD:-0}" != "1" ]]; then
  docker build \
    --file "${script_dir}/Dockerfile" \
    --tag buzz-session-status:local \
    "${repo_root}"
fi

docker run --rm \
  --network none \
  --read-only \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${HOME}/.codex/sessions:/input/codex/sessions:ro" \
  --volume "${HOME}/.codex/session_index.jsonl:/input/codex/session_index.jsonl:ro" \
  --volume "${HOME}/.claude/projects:/input/claude:ro" \
  --volume "${output_dir}:/output:rw" \
  buzz-session-status:local \
  --codex-root /input/codex/sessions \
  --codex-index /input/codex/session_index.jsonl \
  --claude-root /input/claude \
  --output /output/status.json \
  "$@"

printf 'Sanitized index: %s/status.json\n' "${output_dir}"
