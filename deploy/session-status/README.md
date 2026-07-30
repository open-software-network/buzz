# Session status collector

This is an experimental, local-only bridge for producing teammate-safe work
status from Codex and Claude Code sessions without giving a remotely prompted
agent general access to the Mac.

The collector has no server and opens no port. Its container runs with the
network disabled, a read-only root filesystem, no Linux capabilities, and only
three host mounts:

- `~/.codex/sessions` as read-only
- `~/.codex/session_index.jsonl` as a read-only file
- `~/.claude/projects` as read-only
- one output directory as read-write

The output contains session titles and assistant-authored summaries for
explicitly allowed working directories. It never exports user messages,
reasoning, tool inputs, or tool outputs. Common credentials, email addresses,
home-directory usernames, and 64-byte values are redacted as defense in depth.

## Run

Docker Desktop must be running. From the Buzz repository:

```bash
SESSION_STATUS_OUTPUT_DIR="$PWD/.session-status" \
  ./deploy/session-status/collect.sh \
  --allow-root "OpenSoftware=/Users/you/code/open-software" \
  --allow-root "Alongside=/Users/you/code/alongside" \
  --allow-root "Universal=/Users/you/code/universal" \
  --since-hours 48
```

Only configure roots that actually exist in session metadata. An allow-root is
a classification rule; it does not add another filesystem mount. The result is
written to `.session-status/status.json` with mode `0600`.

Review that file before publishing it anywhere. The next integration step is
to publish those records as a narrow Buzz status event or expose that one file
to a hosted agent. Do not mount the user's home directory into the responding
agent.

## Automatic refresh

`refresh.sh` reads approved project mappings from a private per-user file. By
default that file is:

```text
~/Library/Application Support/Buzz/session-status/allow-roots
```

Use one `Label=/absolute/path` mapping per line. Discover candidate paths from
recent Codex and Claude session `cwd` metadata, verify their Git remotes when
available, and have the user approve the narrowest mappings before saving the
file. Missing organizations can be omitted. Never allow `$HOME`, `/Users/name`,
`~/code`, or `/`.

Example only:

```text
OpenSoftware=/absolute/path/to/open-software
Alongside=/absolute/path/to/alongside
Universal=/absolute/path/to/universal
```

Protect the configuration and run the first refresh:

```bash
chmod 600 "$HOME/Library/Application Support/Buzz/session-status/allow-roots"
./deploy/session-status/refresh.sh
```

A macOS LaunchAgent can run `refresh.sh` every five minutes. Set its
`SESSION_STATUS_OUTPUT_DIR` if the default is changed, and optionally set
`SESSION_STATUS_ALLOW_ROOTS_FILE` to use a different allowlist path.

## Security boundary

The container runtime, not the prompt, enforces which host files are visible.
`--network none` also prevents the collector from exfiltrating what it reads.
This does not make automated summaries infallible: assistant output can still
contain sensitive information, so redaction and human review remain important.

The collector itself intentionally does not post to Buzz. Adding relay
credentials to the collector would combine sensitive reads with network access
and weaken the boundary. The separate responder receives only `status.json`
and has no mounts for the raw session directories.

## Buzz responder

`agent-command.sh` is an ACP-speaking responder intended for Buzz's custom
harness support. Buzz Desktop owns the relay connection and agent identity. The
responder runs in a second container with only `status.json` mounted read-only.
It has outbound relay access solely so its bundled Buzz CLI can post the answer.
It has no model credentials, shell tools, raw-session mounts, or general host
filesystem access. The responder is deterministic and invokes the CLI without
a shell, using only the validated channel UUID and reply event ID provided by
the ACP harness.

The responder is deliberately deterministic. It answers work-status questions
from the sanitized index and declines requests for personal data, email,
credentials, browsing, and other private information.

## Tests

```bash
node --test \
  scripts/session-status-collector.test.mjs \
  scripts/session-status-agent.test.mjs
```
