import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnControl = vi.hoisted(() => ({
  spy: vi.fn(),
  real: undefined as typeof import("node:child_process").spawn | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnControl.real = actual.spawn;
  spawnControl.spy.mockImplementation((...args: Parameters<typeof actual.spawn>) => actual.spawn(...args));
  return { ...actual, spawn: spawnControl.spy };
});

import { CbmClient } from "../src/cbm/client.js";
import { CbmToolError } from "../src/cbm/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  spawnControl.spy.mockReset();
  const real = spawnControl.real;
  if (real) spawnControl.spy.mockImplementation((...args: Parameters<typeof real>) => real(...args));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly stdin: { on: () => void; end: (chunk: string) => void } | null;
  killed = false;
  readonly kill = vi.fn();

  constructor(withStdin: boolean) {
    super();
    this.stdin = withStdin
      ? {
          on: () => {},
          end: (chunk) => {
            this.stdinWrites.push(chunk);
          },
        }
      : null;
  }
}

type SpawnCall = { args: string[]; child: FakeChildProcess };

function stubSpawn(text: string, options: { code?: number; isError?: boolean } = {}): SpawnCall[] {
  const calls: SpawnCall[] = [];
  spawnControl.spy.mockImplementationOnce((_command: string, args: string[], spawnOptions: { stdio?: unknown }) => {
    const stdio = spawnOptions?.stdio;
    const child = new FakeChildProcess(Array.isArray(stdio) && stdio[0] === "pipe");
    calls.push({ args, child });
    queueMicrotask(() => {
      const envelope = { content: [{ type: "text", text }] } as { content: Array<{ type: string; text: string }>; isError?: boolean };
      if (options.isError) envelope.isError = true;
      child.stdout.emit("data", Buffer.from(JSON.stringify(envelope)));
      child.emit("close", options.code ?? 0, null);
    });
    return child as unknown as ChildProcess;
  });
  return calls;
}

function stubVersionSpawn(output: string): SpawnCall[] {
  const calls: SpawnCall[] = [];
  spawnControl.spy.mockImplementationOnce((_command: string, args: string[]) => {
    const child = new FakeChildProcess(false);
    calls.push({ args, child });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  });
  return calls;
}

async function fakeBinary(directory: string): Promise<string> {
  const binaryPath = join(directory, "fake-codebase-memory.mjs");
  await writeFile(binaryPath, "#!/usr/bin/env node\nprocess.stdout.write('{}');\n");
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cbm-client-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("CbmClient environment", () => {
  it("forwards the PI cache directory to the upstream CLI", async () => {
    const directory = await temporaryDirectory();
    const observedPath = join(directory, "observed-cache-dir");
    const binaryPath = join(directory, "fake-codebase-memory.mjs");
    await writeFile(
      binaryPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(observedPath)}, process.env.CBM_CACHE_DIR ?? "");\nprocess.stdout.write(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));\n`,
    );
    await chmod(binaryPath, 0o755);
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", binaryPath);
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const legacyCache = join(directory, "legacy-cache");
    const configuredCache = join(directory, "configured-cache");
    vi.stubEnv("CBM_CACHE_DIR", legacyCache);
    vi.stubEnv("PI_CBM_CACHE_DIR", configuredCache);

    const client = new CbmClient();
    await client.callTool("list_projects", {});
    await expect(readFile(observedPath, "utf8")).resolves.toBe(configuredCache);

    vi.stubEnv("PI_CBM_CACHE_DIR", "");
    await client.callTool("list_projects", {});
    await expect(readFile(observedPath, "utf8")).resolves.toBe(legacyCache);
  }, 20_000);
});

describe("CbmClient CLI transport", () => {
  it("sends tool args on stdin and keeps JSON off argv", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const calls = stubSpawn("{}");

    await new CbmClient().callTool("search_graph", { name_pattern: "callTool" });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["cli", "--json", "search_graph"]);
    expect(calls[0].args.every((arg) => !arg.startsWith("{"))).toBe(true);
    expect(JSON.parse(calls[0].child.stdinWrites.join(""))).toEqual({ format: "json", name_pattern: "callTool" });
  });

  it("lists projects with the --format flag and no stdin", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const calls = stubSpawn("{}");

    await new CbmClient().callTool("list_projects", {});

    expect(calls[0].args).toEqual(["cli", "--json", "list_projects", "--format", "json"]);
    expect(calls[0].child.stdin).toBeNull();
    expect(calls[0].child.stdinWrites).toEqual([]);
  });

  it("pages list_projects with the flags captured against real cbm 0.12.1", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const calls = stubSpawn("{}");
    const captured = JSON.parse(readFileSync(new URL("./fixtures/cbm-0.12.1/list_projects.paged.meta.json", import.meta.url), "utf8")) as {
      invocation: string;
      exit_code: number;
    };

    await new CbmClient().callTool("list_projects", { limit: 1, offset: 1 });

    expect(captured.exit_code).toBe(0);
    expect(calls[0].args.join(" ")).toBe(captured.invocation);
  });

  it("keeps a caller-supplied format instead of injecting json", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const calls = stubSpawn("{}");

    await new CbmClient().callTool("search_code", { format: "text", pattern: "callTool" });

    expect(JSON.parse(calls[0].child.stdinWrites.join(""))).toEqual({ format: "text", pattern: "callTool" });
  });

  it("rejects a too-old binary before spawning the tool", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    const versionCalls = stubVersionSpawn("codebase-memory-mcp 0.9.0");

    await expect(new CbmClient().callTool("search_graph", { name_pattern: "x" })).rejects.toThrow(
      /reinstall an earlier pi-cbm release/,
    );

    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0].args).toEqual(["--version"]);
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a pre-aborted signal without spawning the tool", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const controller = new AbortController();
    controller.abort();

    await expect(
      new CbmClient().callTool("search_graph", { name_pattern: "x" }, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(spawnControl.spy).not.toHaveBeenCalled();
  });

  it("surfaces a 0.12 error envelope that exits non-zero", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await fakeBinary(directory));
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
    const calls = stubSpawn('{"error":"symbol not found. Use search_graph(name_pattern=\\"x\\") first."}', {
      code: 1,
      isError: true,
    });

    const error = await new CbmClient().callTool("get_code_snippet", { qualified_name: "missing" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CbmToolError);
    expect(error).toMatchObject({ tool: "get_code_snippet", message: expect.stringMatching(/^symbol not found/) });
    expect(calls[0].args).toEqual(["cli", "--json", "get_code_snippet"]);
  });
});
