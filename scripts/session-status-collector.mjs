#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_SINCE_HOURS = 48;
const DEFAULT_MAX_SESSIONS = 50;
const MAX_EXCERPT_CHARS = 1_200;

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    allowRoots: [],
    claudeRoot: null,
    codexIndex: null,
    codexRoot: null,
    maxSessions: DEFAULT_MAX_SESSIONS,
    output: null,
    sinceHours: DEFAULT_SINCE_HOURS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;

    switch (flag) {
      case "--allow-root": {
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error("--allow-root must use LABEL=/absolute/path");
        }
        const label = value.slice(0, separator).trim();
        const root = value.slice(separator + 1).trim();
        if (!root.startsWith("/")) {
          throw new Error("--allow-root paths must be absolute");
        }
        options.allowRoots.push({ label, root: normalizePath(root) });
        break;
      }
      case "--claude-root":
        options.claudeRoot = resolve(value);
        break;
      case "--codex-index":
        options.codexIndex = resolve(value);
        break;
      case "--codex-root":
        options.codexRoot = resolve(value);
        break;
      case "--max-sessions":
        options.maxSessions = Math.floor(
          parsePositiveNumber(value, "--max-sessions"),
        );
        break;
      case "--output":
        options.output = resolve(value);
        break;
      case "--since-hours":
        options.sinceHours = parsePositiveNumber(value, "--since-hours");
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  if (!options.codexRoot && !options.claudeRoot) {
    throw new Error("provide --codex-root, --claude-root, or both");
  }
  if (options.allowRoots.length === 0) {
    throw new Error("provide at least one --allow-root");
  }
  if (!options.output) {
    throw new Error("provide --output");
  }
  return options;
}

function normalizePath(value) {
  const normalized = resolve(value);
  return normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

export function classifyCwd(cwd, allowRoots) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const normalized = normalizePath(cwd);
  const matches = allowRoots
    .filter(
      ({ root }) => normalized === root || normalized.startsWith(`${root}${sep}`),
    )
    .sort((left, right) => right.root.length - left.root.length);
  if (matches.length === 0) return null;
  const match = matches[0];
  const child = relative(match.root, normalized);
  return {
    label: match.label,
    workspace: child ? `${match.label}/${child}` : match.label,
  };
}

export function redactText(input) {
  if (typeof input !== "string") return "";
  let value = input
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[redacted-secret]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|nsec1[023456789acdefghjklmnpqrstuvwxyz]{20,})\b/g,
      "[redacted-secret]",
    )
    .replace(
      /\b(?:token|api[_-]?key|secret|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted-secret]",
    )
    .replace(
      /\b[A-Fa-f0-9]{64}\b/g,
      "[redacted-64-byte-value]",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[redacted-email]",
    )
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length > MAX_EXCERPT_CHARS) {
    value = `${value.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`;
  }
  return value;
}

function stableSessionId(source, rawId) {
  return createHash("sha256")
    .update(`${source}\0${rawId}`)
    .digest("hex")
    .slice(0, 16);
}

async function* jsonLines(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Agent clients may leave a partial trailing record after a crash. Ignore it.
    }
  }
}

async function listJsonlFiles(root) {
  const resolvedRoot = await realpath(root);
  const output = [];

  async function visit(directory) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        await visit(entryPath);
      } else if (metadata.isFile() && entry.name.endsWith(".jsonl")) {
        const resolvedEntry = await realpath(entryPath);
        if (
          resolvedEntry === resolvedRoot ||
          resolvedEntry.startsWith(`${resolvedRoot}${sep}`)
        ) {
          output.push({ path: resolvedEntry, mtimeMs: metadata.mtimeMs });
        }
      }
    }
  }

  await visit(resolvedRoot);
  return output;
}

async function loadCodexTitles(indexPath) {
  const titles = new Map();
  if (!indexPath) return titles;
  try {
    for await (const record of jsonLines(indexPath)) {
      if (typeof record.id === "string" && typeof record.thread_name === "string") {
        titles.set(record.id, redactText(record.thread_name));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return titles;
}

function codexAssistantText(record) {
  if (record?.type === "event_msg") {
    if (record.payload?.type === "task_complete") {
      return record.payload.last_agent_message;
    }
    if (record.payload?.type === "agent_message") {
      return record.payload.message;
    }
  }
  if (
    record?.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "assistant"
  ) {
    return record.payload.content
      ?.filter((block) => block?.type === "output_text")
      .map((block) => block.text)
      .join("\n");
  }
  return null;
}

async function parseCodexSession(file, allowRoots, titles) {
  let cwd = null;
  let rawId = null;
  let updatedAt = null;
  let summary = "";

  for await (const record of jsonLines(file.path)) {
    if (record?.type === "session_meta") {
      cwd = record.payload?.cwd ?? cwd;
      rawId = record.payload?.session_id ?? record.payload?.id ?? rawId;
      updatedAt = record.payload?.timestamp ?? record.timestamp ?? updatedAt;
    }
    if (typeof record?.timestamp === "string") updatedAt = record.timestamp;
    const candidate = codexAssistantText(record);
    if (candidate) summary = redactText(candidate);
  }

  const project = classifyCwd(cwd, allowRoots);
  if (!project || !rawId) return null;
  const title = titles.get(rawId) ?? "Codex work session";
  return {
    project: project.label,
    session_id: stableSessionId("codex", rawId),
    source: "codex",
    summary,
    title: redactText(title),
    updated_at: updatedAt ?? new Date(file.mtimeMs).toISOString(),
    workspace: project.workspace,
  };
}

function claudeAssistantText(record) {
  if (record?.type !== "assistant" || record.isSidechain === true) return null;
  if (!Array.isArray(record.message?.content)) return null;
  return record.message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function parseClaudeSession(file, allowRoots) {
  let cwd = null;
  let rawId = null;
  let updatedAt = null;
  let title = "Claude work session";
  let summary = "";

  for await (const record of jsonLines(file.path)) {
    cwd = record?.cwd ?? cwd;
    rawId = record?.sessionId ?? rawId;
    if (record?.type === "ai-title" && typeof record.aiTitle === "string") {
      title = redactText(record.aiTitle);
    }
    if (typeof record?.timestamp === "string") updatedAt = record.timestamp;
    const candidate = claudeAssistantText(record);
    if (candidate) summary = redactText(candidate);
  }

  const project = classifyCwd(cwd, allowRoots);
  if (!project || !rawId) return null;
  return {
    project: project.label,
    session_id: stableSessionId("claude", rawId),
    source: "claude",
    summary,
    title,
    updated_at: updatedAt ?? new Date(file.mtimeMs).toISOString(),
    workspace: project.workspace,
  };
}

async function existingDirectory(path) {
  if (!path) return null;
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${path} is not a directory`);
  return path;
}

export async function collectSessions(options, now = Date.now()) {
  const cutoff = now - options.sinceHours * 60 * 60 * 1000;
  const sessions = [];
  const codexTitles = await loadCodexTitles(options.codexIndex);

  const sources = [
    {
      name: "codex",
      root: await existingDirectory(options.codexRoot),
      parse: (file) => parseCodexSession(file, options.allowRoots, codexTitles),
    },
    {
      name: "claude",
      root: await existingDirectory(options.claudeRoot),
      parse: (file) => parseClaudeSession(file, options.allowRoots),
    },
  ];

  for (const source of sources) {
    if (!source.root) continue;
    const files = await listJsonlFiles(source.root);
    for (const file of files) {
      if (file.mtimeMs < cutoff) continue;
      const session = await source.parse(file);
      if (session) sessions.push(session);
    }
  }

  sessions.sort((left, right) =>
    String(right.updated_at).localeCompare(String(left.updated_at)),
  );

  const allowedProjects = [
    ...new Set(options.allowRoots.map(({ label }) => label)),
  ];

  return {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    observation_window_hours: options.sinceHours,
    policy: {
      allowed_projects: allowedProjects,
      includes_raw_user_messages: false,
      includes_tool_inputs_or_outputs: false,
      requires_inbound_listener: false,
    },
    sessions: sessions.slice(0, options.maxSessions),
  };
}

async function writeJsonAtomic(outputPath, value) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, outputPath);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await collectSessions(options);
  await writeJsonAtomic(options.output, result);
  process.stdout.write(
    `wrote ${result.sessions.length} sanitized session summaries to ${options.output}\n`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
