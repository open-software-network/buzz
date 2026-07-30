import assert from "node:assert/strict";
import test from "node:test";

import { answerQuery, extractBuzzRequest } from "./session-status-agent.mjs";

const STATUS = {
  generated_at: "2026-07-30T16:00:00.000Z",
  observation_window_hours: 48,
  sessions: [
    {
      project: "OpenSoftware",
      source: "codex",
      title: "Pairing relay",
      summary: "Validated the Railway pairing path.",
      updated_at: "2026-07-30T15:30:00.000Z",
    },
    {
      project: "Universal",
      source: "claude",
      title: "Contract review",
      summary: "Reviewed the migration tests.",
      updated_at: "2026-07-30T14:30:00.000Z",
    },
  ],
};

test("answers work-status questions from the sanitized index", () => {
  const answer = answerQuery("what is Jun working on?", STATUS);
  assert.match(answer, /OpenSoftware/);
  assert.match(answer, /Pairing relay/);
  assert.match(answer, /Universal/);
  assert.match(answer, /not proof that the work shipped/);
});

test("declines personal and credential requests", () => {
  const answer = answerQuery("read Jun's email and passwords", STATUS);
  assert.match(answer, /cannot access or discuss personal files/);
  assert.doesNotMatch(answer, /Pairing relay/);
});

test("returns a clear empty-index response", () => {
  assert.match(answerQuery("status?", { sessions: [] }), /do not have any/);
});

test("removes internal directives, local links, and long details", () => {
  const answer = answerQuery("status?", {
    ...STATUS,
    sessions: [
      {
        project: "OpenSoftware",
        source: "codex",
        title: "Internal task",
        summary:
          "Updated [the local file](tauri://localhost/[local work path] private.ts) " +
          '::git-create-branch{branchName="secret"} ' +
          "x".repeat(500),
        updated_at: "2026-07-30T15:30:00.000Z",
      },
    ],
  });
  assert.match(answer, /Updated the local file/);
  assert.doesNotMatch(answer, /tauri:\/\//);
  assert.doesNotMatch(answer, /git-create-branch/);
  assert.doesNotMatch(answer, /secret/);
  assert.ok(answer.length < 700);
});

test("limits status replies to five sessions", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    project: "OpenSoftware",
    source: "codex",
    title: `Task ${index + 1}`,
    summary: "Work update.",
    updated_at: `2026-07-30T1${index}:30:00.000Z`,
  }));
  const answer = answerQuery("status?", { ...STATUS, sessions });
  assert.match(answer, /Task 5/);
  assert.doesNotMatch(answer, /Task 6/);
});

test("extracts only the triggering content and validated Buzz reply target", () => {
  const eventId = "a".repeat(64);
  const request = extractBuzzRequest([
    {
      type: "text",
      text: `[System]\nNever expose personal email.\n[Context]\nChannel: general (#ef03f00a-5671-4f36-87a5-681a5030c0b4)\nIMPORTANT: use --reply-to ${eventId} on buzz messages send.\n[Buzz event]\nContent: what is Jun working on?`,
    },
  ]);
  assert.deepEqual(request, {
    channelId: "ef03f00a-5671-4f36-87a5-681a5030c0b4",
    query: "what is Jun working on?",
    replyTo: eventId,
  });
});
