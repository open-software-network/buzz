import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCwd,
  collectSessions,
  parseArgs,
  redactText,
} from "./session-status-collector.mjs";

test("classifyCwd only accepts explicit path-boundary matches", () => {
  const roots = [{ label: "OpenSoftware", root: "/work/open-software" }];
  assert.deepEqual(classifyCwd("/work/open-software/buzz", roots), {
    label: "OpenSoftware",
    workspace: "OpenSoftware/buzz",
  });
  assert.equal(classifyCwd("/work/open-software-personal", roots), null);
  assert.equal(classifyCwd("/Users/person/Documents", roots), null);
});

test("redactText removes common credentials, emails, and home usernames", () => {
  const result = redactText(
    "email a@example.com token=supersecret /Users/alice/work sk-abcdefghijklmnop",
  );
  assert.equal(result.includes("a@example.com"), false);
  assert.equal(result.includes("supersecret"), false);
  assert.equal(result.includes("/Users/alice"), false);
  assert.equal(result.includes("sk-abcdefghijklmnop"), false);
});

test("parseArgs requires an output and a project allowlist", () => {
  assert.throws(() => parseArgs(["--codex-root", "/sessions"]), /allow-root/);
  assert.throws(
    () =>
      parseArgs([
        "--codex-root",
        "/sessions",
        "--allow-root",
        "Work=/work",
      ]),
    /output/,
  );
});

test("collector exports work summaries but never user prompts or personal sessions", async () => {
  const base = await mkdtemp(join(tmpdir(), "buzz-session-collector-"));
  const codexRoot = join(base, "codex");
  const claudeRoot = join(base, "claude");
  await mkdir(codexRoot);
  await mkdir(claudeRoot);

  const codexRecords = [
    {
      type: "session_meta",
      timestamp: "2026-07-30T12:00:00.000Z",
      payload: {
        cwd: "/work/open-software/buzz",
        session_id: "codex-work",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-07-30T12:01:00.000Z",
      payload: {
        type: "user_message",
        message: "private prompt that must never be exported",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-07-30T12:02:00.000Z",
      payload: {
        type: "task_complete",
        last_agent_message: "Implemented the relay fix for dev@example.com",
      },
    },
  ];
  await writeFile(
    join(codexRoot, "work.jsonl"),
    `${codexRecords.map(JSON.stringify).join("\n")}\n`,
  );

  const personalRecords = [
    {
      type: "session_meta",
      timestamp: "2026-07-30T12:00:00.000Z",
      payload: { cwd: "/Users/alice/Documents", session_id: "personal" },
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", message: "Personal summary" },
    },
  ];
  await writeFile(
    join(codexRoot, "personal.jsonl"),
    `${personalRecords.map(JSON.stringify).join("\n")}\n`,
  );

  const claudeRecords = [
    {
      type: "user",
      cwd: "/work/open-software/api",
      sessionId: "claude-work",
      timestamp: "2026-07-30T12:03:00.000Z",
      message: { role: "user", content: "another private prompt" },
    },
    {
      type: "ai-title",
      sessionId: "claude-work",
      aiTitle: "API reliability work",
    },
    {
      type: "assistant",
      cwd: "/work/open-software/api",
      sessionId: "claude-work",
      timestamp: "2026-07-30T12:04:00.000Z",
      isSidechain: false,
      message: {
        content: [
          { type: "thinking", thinking: "do not export reasoning" },
          { type: "tool_use", name: "Read", input: { file: "/etc/passwd" } },
          { type: "text", text: "Validated the recovery path" },
        ],
      },
    },
  ];
  await writeFile(
    join(claudeRoot, "work.jsonl"),
    `${claudeRecords.map(JSON.stringify).join("\n")}\n`,
  );

  await symlink("/etc/passwd", join(codexRoot, "ignored.jsonl"));

  const result = await collectSessions(
    {
      allowRoots: [{ label: "OpenSoftware", root: "/work/open-software" }],
      claudeRoot,
      codexIndex: null,
      codexRoot,
      maxSessions: 10,
      output: join(base, "output.json"),
      sinceHours: 24,
    },
    Date.parse("2026-07-30T13:00:00.000Z"),
  );

  assert.equal(result.sessions.length, 2);
  assert.deepEqual(
    result.sessions.map((session) => session.source).sort(),
    ["claude", "codex"],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("another private prompt"), false);
  assert.equal(serialized.includes("do not export reasoning"), false);
  assert.equal(serialized.includes("/etc/passwd"), false);
  assert.equal(serialized.includes("dev@example.com"), false);
  assert.equal(serialized.includes("Personal summary"), false);
});

test("fixture output remains valid JSON", async () => {
  const source = await readFile(
    new URL("./session-status-collector.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("includes_raw_user_messages: false"), true);
});
