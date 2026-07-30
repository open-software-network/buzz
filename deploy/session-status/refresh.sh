#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${SESSION_STATUS_OUTPUT_DIR:-${HOME}/Library/Application Support/Buzz/session-status}"
allow_roots_file="${SESSION_STATUS_ALLOW_ROOTS_FILE:-${output_dir}/allow-roots}"

if [[ ! -r "${allow_roots_file}" ]]; then
  printf 'Missing approved work-root allowlist: %s\n' "${allow_roots_file}" >&2
  exit 1
fi

collector_args=(--since-hours 48 --max-sessions 50)
allow_root_count=0
while IFS= read -r mapping || [[ -n "${mapping}" ]]; do
  mapping="${mapping%%#*}"
  mapping="${mapping#"${mapping%%[![:space:]]*}"}"
  mapping="${mapping%"${mapping##*[![:space:]]}"}"
  [[ -z "${mapping}" ]] && continue
  collector_args+=(--allow-root "${mapping}")
  allow_root_count=$((allow_root_count + 1))
done < "${allow_roots_file}"

if [[ "${allow_root_count}" -eq 0 ]]; then
  printf 'Approved work-root allowlist is empty: %s\n' "${allow_roots_file}" >&2
  exit 1
fi

SESSION_STATUS_SKIP_BUILD=1 \
SESSION_STATUS_OUTPUT_DIR="${output_dir}" "${script_dir}/collect.sh" \
  "${collector_args[@]}"
