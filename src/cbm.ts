import { access, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_BINARY = "codebase-memory-mcp";
const FALLBACK_BINARY_PATHS = ["/Users/alxknt/.local/bin/codebase-memory-mcp", "~/.local/bin/codebase-memory-mcp"];
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_INDEX_TIMEOUT_MS = 20 * 60_000;
const MAX_STDIO_BYTES = 50 * 1024 * 1024;

type CbmEnvelope = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type CbmCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowError?: boolean;
};

export type CbmCallResult = {
  ok: boolean;
  data: unknown;
  rawText: string;
  stderr: string;
};

export type ToolTextResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function existsExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command: string): Promise<string | undefined> {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (await existsExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveCbmBinary(): Promise<string> {
  const configured = process.env.CODEBASE_MEMORY_MCP_BIN?.trim() || process.env.CBM_BIN?.trim();
  if (configured) {
    const path = expandHome(configured);
    if (await existsExecutable(path)) return path;
    throw new Error(`Configured codebase-memory-mcp binary does not exist: ${path}`);
  }

  const fromPath = await findOnPath(DEFAULT_BINARY);
  if (fromPath) return fromPath;

  for (const fallback of FALLBACK_BINARY_PATHS) {
    const path = expandHome(fallback);
    if (await existsExecutable(path)) return path;
  }

  throw new Error(
    "codebase-memory-mcp binary not found. Install it or set CODEBASE_MEMORY_MCP_BIN=/path/to/codebase-memory-mcp.",
  );
}

function parseEnvelope(stdout: string): { envelope: CbmEnvelope; text: string } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("codebase-memory-mcp produced no JSON output");

  const candidates = [
    trimmed,
    ...trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .reverse(),
  ];

  let envelope: CbmEnvelope | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as CbmEnvelope;
      if (parsed && typeof parsed === "object" && (Array.isArray(parsed.content) || "isError" in parsed)) {
        envelope = parsed;
        break;
      }
    } catch {
      // Ignore log lines or partial output before the JSON envelope.
    }
  }

  if (!envelope) throw new Error(`Could not parse codebase-memory-mcp JSON envelope from output: ${trimmed.slice(0, 500)}`);

  const firstText = envelope.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  return { envelope, text: firstText ?? trimmed };
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

export async function callCbmTool(toolName: string, args: Record<string, unknown>, options: CbmCallOptions = {}): Promise<CbmCallResult> {
  const binary = await resolveCbmBinary();
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const child = spawn(binary, ["cli", "--json", toolName, JSON.stringify(args)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let settled = false;

  const kill = () => {
    if (!settled && !child.killed) child.kill("SIGTERM");
  };

  const timeout = setTimeout(kill, timeoutMs);
  options.signal?.addEventListener("abort", kill, { once: true });

  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDIO_BYTES) {
          reject(new Error(`codebase-memory-mcp stdout exceeded ${formatSize(MAX_STDIO_BYTES)}`));
          kill();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stderr, "utf8") > MAX_STDIO_BYTES) {
          stderr = `${stderr.slice(0, MAX_STDIO_BYTES)}\n[stderr truncated]`;
        }
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    settled = true;

    if (options.signal?.aborted) throw new Error(`codebase-memory-mcp ${toolName} cancelled`);
    if (signal) throw new Error(`codebase-memory-mcp ${toolName} terminated by ${signal}`);
    if (code !== 0 && !stdout.trim()) {
      throw new Error(`codebase-memory-mcp ${toolName} failed with exit code ${code}: ${stderr.trim()}`);
    }

    const { envelope, text } = parseEnvelope(stdout);
    const data = parseMaybeJson(text);
    const ok = envelope.isError !== true;
    if (!ok && !options.allowError) throw new Error(typeof data === "string" ? data : JSON.stringify(data));

    return { ok, data, rawText: text, stderr };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", kill);
  }
}

export function indexTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INDEX_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(value), 24 * 60 * 60_000));
}

export function queryTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUERY_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(value), 10 * 60_000));
}

export async function buildToolTextResult(title: string, data: unknown, details: Record<string, unknown> = {}): Promise<ToolTextResult> {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const truncation = truncateHead(json, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });

  let text = `${title}\n\n${truncation.content}`;
  const resultDetails: Record<string, unknown> = { ...details, data };

  if (typeof resultDetails.uncompactedOutputPath === "string") {
    text += `\n\n[Large code blocks were compacted. Full un-compacted output saved to: ${resultDetails.uncompactedOutputPath}. Rerun with full_output=true or increase max_symbol_lines to include more in the response.]`;
  }

  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-cbm-"));
    const path = join(dir, "result.json");
    await writeFile(path, json, "utf8");
    resultDetails.fullOutputPath = path;
    resultDetails.truncation = truncation;
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
      truncation.outputBytes,
    )} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${path}]`;
  }

  return { content: [{ type: "text", text }], details: resultDetails };
}

export async function saveJsonResult(data: unknown, filename = "result.full.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cbm-"));
  const path = join(dir, filename);
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
  return path;
}

export function removeUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function normalizePathForDisplay(path: string): string {
  if (!isAbsolute(path)) return path;
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function basename(path: string): string {
  const parent = dirname(path);
  return parent === path ? path : path.slice(parent.length + 1);
}
