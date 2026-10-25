import { spawn } from "node:child_process";
import { resolveCbmBinary } from "./binary.js";
import { parseCbmEnvelope, parseMaybeJson } from "./envelope.js";
import { CbmToolError } from "./errors.js";
import { normalizeCbmData } from "./normalize.js";
import type { CbmCallOptions, CbmCallResult } from "./result.js";
import { DEFAULT_QUERY_TIMEOUT_MS } from "./timeouts.js";
import { CbmVersionGate, type CbmVersionCheck, type CbmVersionNotice } from "./version.js";
import { formatSize } from "../shared/strings.js";

const MAX_STDIO_BYTES = 50 * 1024 * 1024;

export class CbmClient {
  constructor(private readonly versionGate = new CbmVersionGate()) {}

  /** Probe the configured binary's version (once per binary; see `takeVersionNotices`). */
  async checkVersion(signal?: AbortSignal): Promise<CbmVersionCheck> {
    return this.versionGate.check(await resolveCbmBinary(), signal);
  }

  /** Compatibility notices (too old, untested newer, unknown version) not yet shown to the user. */
  takeVersionNotices(): CbmVersionNotice[] {
    return this.versionGate.takeNotices();
  }

  async findGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const kill = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", kill, { once: true });

    try {
      const output = await new Promise<string>((resolveOutput) => {
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.on("error", () => resolveOutput(""));
        child.on("close", (code) => resolveOutput(code === 0 ? stdout.trim() : ""));
      });

      return output || undefined;
    } finally {
      signal?.removeEventListener("abort", kill);
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>, options: CbmCallOptions = {}): Promise<CbmCallResult> {
    const binary = await resolveCbmBinary();
    const version = await this.versionGate.check(binary, options.signal);
    if (version.status === "too-old") {
      throw new Error(version.message ?? `codebase-memory-mcp ${version.version ?? "?"} is unsupported`);
    }

    // 0.12 ignores `format` on stdin for list_projects, so that one uses the flag and no stdin.
    // limit/offset are forwarded as flags so callers can page past cbm's default 50; other args stay dropped.
    const argv = ["cli", "--json", toolName];
    let stdin: string | undefined;
    if (toolName === "list_projects") {
      argv.push("--format", "json");
      for (const flag of ["limit", "offset"] as const) {
        const value = args[flag];
        if (typeof value === "number" && Number.isInteger(value)) argv.push(`--${flag}`, String(value));
      }
    } else {
      stdin = JSON.stringify({ format: "json", ...args });
    }

    if (options.signal?.aborted) throw new Error(`codebase-memory-mcp ${toolName} cancelled`);

    const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    const child = spawn(binary, argv, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: resolveCbmEnvironment(),
    });

    if (stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    }

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

      const { envelope, text } = parseCbmEnvelope(stdout);
      const data = normalizeCbmData(parseMaybeJson(text));
      const ok = envelope.isError !== true;
      if (!ok && !options.allowError) throw new CbmToolError(toolName, data);

      return { ok, data, rawText: text, stderr };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
    }
  }
}

function resolveCbmEnvironment(): NodeJS.ProcessEnv | undefined {
  const cacheDirectory = process.env.PI_CBM_CACHE_DIR?.trim() || process.env.CBM_CACHE_DIR?.trim();
  if (!cacheDirectory) return undefined;
  return { ...process.env, CBM_CACHE_DIR: cacheDirectory };
}
