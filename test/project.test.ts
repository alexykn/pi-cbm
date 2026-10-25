import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { IndexingService } from "../src/domain/indexing.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver } from "../src/domain/project-resolver.js";

type ProjectRow = { name: string; root_path: string };

function okPage(projects: ProjectRow[], hasMore = false): CbmCallResult {
  return { ok: true, data: { projects, total: projects.length, has_more: hasMore }, rawText: "", stderr: "" };
}

/** A captured 0.12.1 `list_projects --format json` result. */
function listFixture(name: string): CbmCallResult {
  const envelope = JSON.parse(readFileSync(new URL(`./fixtures/cbm-0.12.1/list_projects.${name}.json`, import.meta.url), "utf8")) as {
    content: Array<{ text: string }>;
  };
  return { ok: true, data: JSON.parse(envelope.content[0]!.text), rawText: "", stderr: "" };
}

function errorResult(error: string): CbmCallResult {
  return { ok: false, data: { error }, rawText: "", stderr: "" };
}

type Fake = {
  list?: (args: Record<string, unknown>, call: number) => CbmCallResult | Promise<CbmCallResult>;
  gitRoot?: string;
  extra?: (tool: string, args: Record<string, unknown>) => CbmCallResult | Promise<CbmCallResult>;
};

function serviceWith(options: Fake = {}) {
  const listArgs: Array<Record<string, unknown>> = [];
  const coordinator = {
    acquire: async () => ({ ok: true, lease: { signal: new AbortController().signal, release: async () => {} } }),
  } as unknown as IndexCoordinator;
  const cbm = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CbmCallResult> => {
      if (tool === "list_projects") {
        listArgs.push(args);
        return options.list ? options.list(args, listArgs.length) : okPage([{ name: "repo", root_path: "/work/repo" }]);
      }
      if (options.extra) return options.extra(tool, args);
      throw new Error(`unexpected cbm tool: ${tool}`);
    },
    findGitRoot: async () => options.gitRoot,
  } as unknown as CbmClient;
  const catalog = new ProjectCatalog(cbm);
  return {
    catalog,
    resolver: new ProjectResolver(cbm, catalog),
    indexing: new IndexingService(cbm, { autoIndexNonGitDirectories: false }, coordinator, catalog),
    listArgs,
  };
}

describe("project resolution", () => {
  it("infers the project whose root contains the cwd", async () => {
    await expect(serviceWith().resolver.resolveProject(undefined, "/work/repo/src/domain")).resolves.toBe("repo");
  });

  it("picks the longest matching root for nested projects", async () => {
    const { resolver } = serviceWith({
      list: () =>
        okPage([
          { name: "outer", root_path: "/work" },
          { name: "inner", root_path: "/work/repo" },
        ]),
    });

    await expect(resolver.resolveProject(undefined, "/work/repo/src")).resolves.toBe("inner");
  });

  it("prefers cbm's derived name when a custom-named project shares the same root", async () => {
    // Captured: one root indexed by default and again as "custom-shared-root", which sorts first.
    const listed = listFixture("shared-root");
    const projects = (listed.data as { projects: ProjectRow[] }).projects;
    const root = projects.find((project) => project.name === "custom-shared-root")!.root_path;
    const derived = projects.find((project) => project.root_path === root && project.name !== "custom-shared-root")!.name;
    const { resolver } = serviceWith({ list: () => listed });

    await expect(resolver.resolveProject(undefined, `${root}/src`)).resolves.toBe(derived);
    await expect(resolver.resolveProject(root, "/home/user")).resolves.toBe(derived);
    await expect(resolver.resolveProject("custom-shared-root", "/home/user")).resolves.toBe("custom-shared-root");
  });

  it("fails loudly with the indexed projects when the cwd matches nothing", async () => {
    const { resolver } = serviceWith({ list: () => okPage([{ name: "other", root_path: "/work/other" }]) });

    await expect(resolver.resolveProject(undefined, "/home/user")).rejects.toThrow(/cwd "\/home\/user", which has no git root/);
    await expect(resolver.resolveProject(undefined, "/home/user")).rejects.toThrow(/indexed projects: other -> \/work\/other/);
    await expect(resolver.resolveProject(undefined, "/home/user")).rejects.toThrow(/absolute path/);
  });

  it("says so when no project is indexed at all", async () => {
    const { resolver } = serviceWith({ list: () => okPage([]) });

    await expect(resolver.resolveProject(undefined, "/home/user")).rejects.toThrow(/no projects are indexed yet/);
  });

  it("maps an explicit absolute path, with or without a trailing slash, to the project name", async () => {
    const { resolver } = serviceWith();

    await expect(resolver.resolveProject("/work/repo/src", "/home/user")).resolves.toBe("repo");
    await expect(resolver.resolveProject("/work/repo/", "/home/user")).resolves.toBe("repo");
  });

  it("resolves an explicitly relative path against the cwd", async () => {
    const { resolver } = serviceWith();

    await expect(resolver.resolveProject(".", "/work/repo/src")).resolves.toBe("repo");
    await expect(resolver.resolveProject("./src", "/work/repo")).resolves.toBe("repo");
    await expect(resolver.resolveProject("..", "/work/repo/src")).resolves.toBe("repo");
  });

  it("rejects an unknown bare name even when the cwd is inside another indexed project", async () => {
    const { resolver } = serviceWith({ list: () => okPage([{ name: "my-repo", root_path: "/work/my-repo" }]), gitRoot: "/work/my-repo" });

    await expect(resolver.resolveProject("other-repo", "/work/my-repo/src")).rejects.toThrow(/given value "other-repo"/);
  });

  it("rejects an unknown project name with the actionable list, not symbol-not-found", async () => {
    let message = "";
    try {
      await serviceWith().resolver.resolveProject("home-user", "/home/user");
      expect.unreachable("unknown project should throw");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/given value "home-user"/);
    expect(message).toMatch(/indexed projects: repo -> \/work\/repo/);
    expect(message).toMatch(/absolute path/);
    expect(message).not.toMatch(/symbol not found/i);
  });

  it("caches list_projects across resolutions within the TTL", async () => {
    const { resolver, listArgs } = serviceWith();

    await resolver.resolveProject(undefined, "/work/repo");
    await resolver.resolveProject("/work/repo/src", "/home/user");

    expect(listArgs).toHaveLength(1);
  });

  it("re-lists after the cache TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const { resolver, listArgs } = serviceWith();

      await resolver.resolveProject(undefined, "/work/repo");
      vi.advanceTimersByTime(10_001);
      await resolver.resolveProject(undefined, "/work/repo");

      expect(listArgs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries past a stale cache so a project indexed since the last list still resolves", async () => {
    const { resolver, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? okPage([]) : okPage([{ name: "repo", root_path: "/work/repo" }])),
    });

    await expect(resolver.resolveProject("repo", "/home/user")).resolves.toBe("repo");
    expect(listArgs).toHaveLength(2);
  });

  it("pages through list_projects until has_more is false", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ name: `p${index}`, root_path: `/work/p${index}` }));
    const { resolver, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? okPage(firstPage, true) : okPage([{ name: "target", root_path: "/target" }])),
    });

    await expect(resolver.resolveProject("target", "/home/user")).resolves.toBe("target");
    expect(listArgs).toHaveLength(2);
    expect(listArgs[0]).toMatchObject({ limit: 50, offset: 0 });
    expect(listArgs[1]).toMatchObject({ limit: 50, offset: 50 });
  });

  it("does not cache a failed list_projects", async () => {
    const { resolver, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? errorResult("boom") : okPage([{ name: "repo", root_path: "/work/repo" }])),
    });

    await expect(resolver.resolveProject(undefined, "/work/repo")).rejects.toThrow(/boom/);
    await expect(resolver.resolveProject(undefined, "/work/repo")).resolves.toBe("repo");
    expect(listArgs).toHaveLength(2);
  });

  it("passes an explicit name through when list_projects fails, leaving the verdict to cbm", async () => {
    const { resolver } = serviceWith({ list: () => errorResult("boom") });

    await expect(resolver.resolveProject("repo", "/home/user")).resolves.toBe("repo");
    await expect(resolver.resolveProject("/work/repo", "/home/user")).rejects.toThrow(/boom/);
  });

  it("lets an aborted caller stop waiting without cancelling the shared fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { resolver, listArgs } = serviceWith({
      list: async () => {
        await gate;
        return okPage([{ name: "repo", root_path: "/work/repo" }]);
      },
    });

    const controller = new AbortController();
    const aborted = resolver.resolveProject("repo", "/home/user", controller.signal);
    const waiting = resolver.resolveProject("repo", "/home/user");
    controller.abort();

    await expect(aborted).rejects.toThrow(/cancelled/);
    release();
    await expect(waiting).resolves.toBe("repo");
    expect(listArgs).toHaveLength(1);
  });

  it("does not let an aborted caller hide the project root from a concurrent caller", async () => {
    let release!: (value: CbmCallResult) => void;
    const { catalog } = serviceWith({ list: () => new Promise<CbmCallResult>((resolve) => (release = resolve)) });
    const controller = new AbortController();
    const aborted = catalog.relativizePaths({ file_path: "/work/repo/src/a.ts" }, "repo", controller.signal);
    const waiting = catalog.relativizePaths({ file_path: "/work/repo/src/a.ts" }, "repo");
    controller.abort();
    release(okPage([{ name: "repo", root_path: "/work/repo" }]));

    await aborted;
    await expect(waiting).resolves.toEqual({ file_path: "src/a.ts" });
    await expect(catalog.relativizePaths({ file_path: "/work/repo/src/a.ts" }, "repo")).resolves.toEqual({ file_path: "src/a.ts" });
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "relativizes a path whose case differs from the root on a case-insensitive filesystem",
    async () => {
      const { catalog } = serviceWith({ list: () => okPage([{ name: "repo", root_path: "/Work/Repo/" }]) });

      await expect(catalog.relativizePaths({ file_path: "/work/repo/src/a.ts" }, "repo")).resolves.toEqual({ file_path: "src/a.ts" });
    },
  );

  it("does not cache a fetch that raced an index", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { catalog, indexing, listArgs } = serviceWith({
      gitRoot: "/work/repo",
      list: async (_args, call) => {
        if (call === 1) {
          await gate;
          return okPage([]);
        }
        return okPage([{ name: "repo", root_path: "/work/repo" }]);
      },
      extra: (tool) => {
        if (tool === "index_repository") return { ok: true, data: { project: "repo" }, rawText: "", stderr: "" };
        throw new Error(`unexpected cbm tool: ${tool}`);
      },
    });

    const stale = catalog.list();
    await indexing.indexCurrentRepo("/work/repo");
    release();
    await expect(stale).resolves.toEqual([]);

    await expect(catalog.list()).resolves.toEqual([{ name: "repo", root_path: "/work/repo" }]);
    expect(listArgs).toHaveLength(2);
  });

  it("resolves a symlinked cwd through realpath", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-cbm-project-"));
    try {
      const real = join(base, "real-repo");
      await mkdir(real);
      const link = join(base, "link-repo");
      await symlink(real, link, "dir");
      const { resolver } = serviceWith({ list: () => okPage([{ name: "repo", root_path: real }]) });

      await expect(resolver.resolveProject(undefined, link)).resolves.toBe("repo");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
