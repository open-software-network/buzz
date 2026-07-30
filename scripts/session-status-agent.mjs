#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_STATUS_PATH = "/status/status.json";
const MAX_ITEMS = 5;
const MAX_SUMMARY_CHARS = 360;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content?.text === "string") return part.content.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractBuzzRequest(prompt) {
  const text = promptText(prompt);
  const contentMatches = [...text.matchAll(/^Content:\s*(.*)$/gim)];
  const query =
    contentMatches.at(-1)?.[1]?.trim() || text.slice(-4_000).trim();
  const channelMatch = text.match(
    new RegExp(`^Channel:.*?(?:#)?(${UUID_PATTERN})(?:\\)|\\s|$)`, "im"),
  );
  const replyMatches = [
    ...text.matchAll(/--reply-to\s+([0-9a-f]{64})/gi),
  ];
  return {
    channelId: channelMatch?.[1]?.toLowerCase() ?? null,
    query,
    replyTo: replyMatches.at(-1)?.[1]?.toLowerCase() ?? null,
  };
}

function isPersonalRequest(query) {
  return /\b(personal|email|inbox|health|medical|relationship|family|finance|bank|password|credential|secret|browser|photo|location|private message)\b/i.test(
    query,
  );
}

function cleanLine(value) {
  return String(value ?? "")
    .replace(/::[a-z0-9-]+\{[^}]*\}/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:tauri|file|https?):\/\/\S+/gi, "[work link]")
    .replace(/(?:\/Users\/[^\s),]+|~\/[^\s),]+)/g, "[local work path]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSummary(value) {
  const summary = cleanLine(value);
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function uniqueRecentSessions(sessions) {
  const seen = new Set();
  const result = [];
  for (const session of sessions ?? []) {
    const title = cleanLine(session.title) || "Work session";
    const key = `${session.project ?? "Work"}\0${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...session, title });
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
}

export function answerQuery(query, status) {
  if (isPersonalRequest(query)) {
    return "I can only report sanitized OpenSoftware, Alongside, and Universal coding-session activity. I cannot access or discuss personal files, email, browsing, credentials, or other private data.";
  }

  const sessions = uniqueRecentSessions(status?.sessions);
  if (sessions.length === 0) {
    return "I do not have any recent sanitized Codex or Claude work-session activity in the current index.";
  }

  const generatedAt = formatTimestamp(status.generated_at);
  const window = status.observation_window_hours ?? "configured";
  const lines = [
    `From the sanitized Codex/Claude index generated ${generatedAt} (last ${window} hours):`,
    "",
  ];

  for (const session of sessions) {
    const project = cleanLine(session.project) || "Work";
    const source = cleanLine(session.source) || "agent";
    const title = cleanLine(session.title);
    const summary = cleanSummary(session.summary);
    lines.push(
      `- **${project} · ${title}** (${source}, ${formatTimestamp(session.updated_at)})${
        summary ? ` — ${summary}` : ""
      }`,
    );
  }

  lines.push(
    "",
    "This reports observed coding-session activity, not proof that the work shipped or was deployed.",
  );
  return lines.join("\n");
}

async function loadStatus(statusPath) {
  return JSON.parse(await readFile(statusPath, "utf8"));
}

async function sendBuzzReply({ answer, channelId, replyTo }) {
  if (!channelId || !replyTo) {
    throw new Error("Buzz prompt did not include a validated channel and reply anchor");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "buzz",
      [
        "messages",
        "send",
        "--channel",
        channelId,
        "--content",
        "-",
        "--reply-to",
        replyTo,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`buzz reply failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(answer);
  });
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function result(id, value) {
  writeFrame({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  writeFrame({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function handleFrame(frame, options = {}) {
  const statusPath = options.statusPath ?? DEFAULT_STATUS_PATH;
  switch (frame?.method) {
    case "initialize":
      result(frame.id, {
        protocolVersion: frame.params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: "buzz-session-status", version: "0.1.0" },
      });
      return;
    case "session/new":
      result(frame.id, { sessionId: `status_${randomUUID()}` });
      return;
    case "session/prompt": {
      try {
        const status = await loadStatus(statusPath);
        const request = extractBuzzRequest(frame.params?.prompt);
        const answer = answerQuery(request.query, status);
        await sendBuzzReply({ ...request, answer });
        writeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: frame.params?.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: answer },
            },
          },
        });
        result(frame.id, { stopReason: "end_turn" });
      } catch (loadError) {
        const message =
          loadError instanceof Error ? loadError.message : String(loadError);
        error(frame.id, -32000, `status index unavailable: ${message}`);
      }
      return;
    }
    case "session/cancel":
      return;
    default:
      if (frame?.id !== undefined) {
        error(frame.id, -32601, `method not found: ${frame.method}`);
      }
  }
}

export async function main() {
  const statusPath = process.env.BUZZ_SESSION_STATUS_PATH ?? DEFAULT_STATUS_PATH;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      await handleFrame(JSON.parse(line), { statusPath });
    } catch (frameError) {
      process.stderr.write(
        `${frameError instanceof Error ? frameError.message : frameError}\n`,
      );
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((mainError) => {
    process.stderr.write(
      `${mainError instanceof Error ? mainError.message : mainError}\n`,
    );
    process.exitCode = 1;
  });
}
