import { spawn } from "node:child_process";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { resolveCbmBinary } from "./binary.js";
import { parseCbmEnvelope, parseMaybeJson } from "./envelope.js";
import type { CbmCallOptions, CbmCallResult } from "./result.js";
import { DEFAULT_QUERY_TIMEOUT_MS } from "./timeouts.js";

const MAX_STDIO_BYTES = 50 * 1024 * 1024;

export class CbmClient {
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

  async gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.findGitRoot(cwd, signal)) ?? cwd;
  }

  async callTool(toolName: string, args: Record<string, unknown>, options: CbmCallOptions = {}): Promise<CbmCallResult> {
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

      const { envelope, text } = parseCbmEnvelope(stdout);
      const data = parseMaybeJson(text);
      const ok = envelope.isError !== true;
      if (!ok && !options.allowError) throw new Error(typeof data === "string" ? data : JSON.stringify(data));

      return { ok, data, rawText: text, stderr };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", kill);
    }
  }
}
