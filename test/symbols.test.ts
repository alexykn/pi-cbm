import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { CbmClient } from "../src/cbm/client.js";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver, type ToolExecutionContext } from "../src/domain/project-resolver.js";
import { SymbolService } from "../src/domain/symbols.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);
const PROJECT = "tmp-cbm-fixture-repo";
const ROOT = "/tmp/cbm-fixture-repo";
const CTX: ToolExecutionContext = { cwd: ROOT };

/** Raw 0.12.1 fixture through the same parse + normalize path as CbmClient. */
function fixture(name: string): CbmCallResult {
  const envelope = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = envelope.content[0]?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: envelope.isError !== true, data: normalizeCbmData(parsed), rawText: text, stderr: "" };
}

function fakeClient(
  handler: (tool: string, args: Record<string, unknown>) => CbmCallResult,
  projects: CbmCallResult = fixture("list_projects.format-flag"),
): CbmClient {
  return {
    callTool: async (tool: string, args: Record<string, unknown>) => (tool === "list_projects" ? projects : handler(tool, args)),
  } as unknown as CbmClient;
}

function serviceWith(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult, projects?: CbmCallResult): SymbolService {
  const cbm = fakeClient(handler, projects);
  const catalog = new ProjectCatalog(cbm);
  return new SymbolService(cbm, new ProjectResolver(cbm, catalog), catalog, new OutputService());
}

function snippetResult(data: Record<string, unknown>): CbmCallResult {
  return { ok: true, data, rawText: "", stderr: "" };
}

function projectsResult(name: string, rootPath?: string): CbmCallResult {
  return { ok: true, data: { projects: [{ name, root_path: rootPath }], total: 1, has_more: false }, rawText: "", stderr: "" };
}

const searchByName = () => fixture("search_graph.name-pattern");

describe("SymbolService on cbm 0.12 shapes", () => {
  it("resolves a one-hit name to one candidate with a repo-relative location", async () => {
    const service = serviceWith(() => searchByName());
    const resolution = await service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX);

    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]).toMatchObject({
      name: "callTool",
      qualified_name: "tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool",
      file_path: "src/cbm/client.ts",
      start_line: 43,
      end_line: 100,
    });
  });

  it("keeps every row as a candidate when the name matches none exactly", async () => {
    const service = serviceWith(() => fixture("search_graph.label"));
    const resolution = await service.resolveCandidates({ name: "missing", project: PROJECT }, CTX);

    expect(resolution.candidates.map((candidate) => candidate.name)).toEqual([
      "abortAll",
      "acquire",
      "autoIndexNonGitDirectories",
    ]);
  });

  it("throws a contract error instead of returning [] for an unrecognized search_graph shape", async () => {
    const service = serviceWith(() => ({
      ok: true,
      data: { qn_rule: 'qn = qn_prefix + "." + name', cols: ["name", "label"] },
      rawText: "",
      stderr: "",
    }));

    await expect(service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX)).rejects.toThrow(
      /codebase-memory-mcp search_graph.*unrecognized result shape.*qn_rule, cols/,
    );
  });

  it("treats empty results as a legitimate symbol-not-found", async () => {
    const service = serviceWith(() => ({ ok: true, data: { total: 0, has_more: false, results: [] }, rawText: "", stderr: "" }));
    const result = await service.resolve({ name: "missing", project: PROJECT }, CTX);

    expect(result.details.data).toMatchObject({ error: "symbol not found", total_candidates: 0 });
  });

  it("rewrites an absolute get_code_snippet file_path to repo-relative", async () => {
    const service = serviceWith((tool) => (tool === "get_code_snippet" ? fixture("get_code_snippet.known") : searchByName()));

    const location = await service.fetchSymbolLocation("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool", PROJECT, CTX, {}, new Map());
    expect(location.file_path).toBe("src/cbm/client.ts");

    const read = await service.read({ name: "callTool", project: PROJECT }, CTX);
    const data = read.details.data as Record<string, unknown>;
    expect(data.file_path).toBe("src/cbm/client.ts");
    expect(JSON.stringify(data)).not.toContain(ROOT);
  });

  it("surfaces a failed search_graph lookup instead of reporting symbol-not-found", async () => {
    const service = serviceWith(() => fixture("search_graph.unknown-project"), projectsResult("no-such-project"));

    await expect(service.resolveCandidates({ name: "callTool", project: "no-such-project" }, CTX)).rejects.toThrow(
      /project not found or not indexed.*available_projects: tmp-cbm-fixture-repo.*absolute path/,
    );
  });

  it("enriches a get_code_snippet project error with the indexed project list", async () => {
    const service = serviceWith(() => ({
      ok: false,
      data: { error: "project not found or not indexed", hint: "Use list_projects.", available_projects: ["tmp-cbm-fixture-repo"] },
      rawText: "",
      stderr: "",
    }));

    const result = await service.getSnippets({ qualified_names: ["missing"], project: PROJECT }, CTX);
    const results = (result.details.data as { results: Array<{ error?: string }> }).results;

    expect(results[0]?.error).toMatch(/project not found or not indexed/);
    expect(results[0]?.error).toMatch(/absolute path/);
  });

  it("tolerates a partial search_graph failure", async () => {
    const service = serviceWith((tool, args) => (args.query ? fixture("search_graph.unknown-project") : searchByName()));
    const resolution = await service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX);

    expect(resolution.candidates).toHaveLength(1);
  });

  it("requests extra search_graph fields for disambiguation", async () => {
    const searches: Record<string, unknown>[] = [];
    const service = serviceWith((tool, args) => {
      if (tool === "search_graph") searches.push(args);
      return searchByName();
    });

    await service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX);

    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((args) => Array.isArray(args.fields) && (args.fields as string[]).includes("parent_class"))).toBe(true);
  });

  it("fails closed on an ambiguous name without reading source", async () => {
    const tools: string[] = [];
    const service = serviceWith((tool) => {
      tools.push(tool);
      return fixture("search_graph.label");
    });

    const result = await service.read({ name: "missing", project: PROJECT }, CTX);
    const data = result.details.data as Record<string, unknown>;
    expect(data.ambiguous).toBe(true);
    expect(data.candidates).toHaveLength(3);
    expect(tools).not.toContain("get_code_snippet");
  });

  it("filters parent_class as a short name and as the full qualified prefix", async () => {
    const service = serviceWith(() => fixture("search_graph.fields"));

    const short = await service.resolveCandidates({ name: "callTool", parent_class: "CbmClient", project: PROJECT }, CTX);
    expect(short.candidates).toHaveLength(1);

    const full = await service.resolveCandidates(
      { name: "callTool", parent_class: "tmp-cbm-fixture-repo.src.cbm.client.CbmClient", project: PROJECT },
      CTX,
    );
    expect(full.candidates).toHaveLength(1);

    const none = await service.resolveCandidates({ name: "callTool", parent_class: "Other", project: PROJECT }, CTX);
    expect(none.candidates).toHaveLength(0);
  });

  it("reads a batch of symbols with repo-relative snippet paths", async () => {
    const service = serviceWith((tool) => (tool === "get_code_snippet" ? fixture("get_code_snippet.known") : searchByName()));
    const result = await service.readMany({ symbols: [{ name: "callTool" }], project: PROJECT }, CTX);
    const results = (result.details.data as { results: Array<Record<string, unknown>> }).results;

    expect(results[0]).toMatchObject({ status: "ok" });
    expect((results[0]!.snippet as Record<string, unknown>).file_path).toBe("src/cbm/client.ts");
  });

  it("searches and reads in one call with repo-relative snippet paths", async () => {
    const service = serviceWith((tool) => (tool === "get_code_snippet" ? fixture("get_code_snippet.known") : searchByName()));
    const result = await service.searchAndRead({ query: "callTool", project: PROJECT }, CTX);
    const results = (result.details.data as { results: Array<Record<string, unknown>> }).results;

    expect(results[0]).toMatchObject({ status: "ok", qualified_name: "tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool" });
    expect((results[0]!.snippet as Record<string, unknown>).file_path).toBe("src/cbm/client.ts");
  });

  it("rewrites a Windows drive-letter path case-insensitively", async () => {
    const service = serviceWith(
      () => snippetResult({ name: "x", qualified_name: "q", label: "Function", file_path: "c:/repo/src/a.ts", start_line: 1, end_line: 2 }),
      projectsResult("win", "C:\\Repo"),
    );

    const location = await service.fetchSymbolLocation("q", "win", CTX, {}, new Map());
    expect(location.file_path).toBe("src/a.ts");
  });

  it("leaves a path outside the project root absolute", async () => {
    const service = serviceWith(() => snippetResult({ name: "x", qualified_name: "q", file_path: "/elsewhere/src/a.ts", start_line: 1, end_line: 2 }));

    const location = await service.fetchSymbolLocation("q", PROJECT, CTX, {}, new Map());
    expect(location.file_path).toBe("/elsewhere/src/a.ts");
  });

  it("leaves the path absolute when the project root cannot be resolved", async () => {
    const service = serviceWith(
      () => snippetResult({ name: "x", qualified_name: "q", file_path: "/tmp/cbm-fixture-repo/src/a.ts", start_line: 1, end_line: 2 }),
      { ok: false, data: { error: "cannot read cache directory: /missing" }, rawText: "", stderr: "" },
    );

    const location = await service.fetchSymbolLocation("q", PROJECT, CTX, {}, new Map());
    expect(location.file_path).toBe("/tmp/cbm-fixture-repo/src/a.ts");
  });

  it("reuses a missing-root lookup within the miss TTL", async () => {
    let listCalls = 0;
    const cbm = {
      callTool: async (tool: string) => {
        if (tool === "list_projects") {
          listCalls += 1;
          return { ok: true, data: { projects: [], total: 0, has_more: false }, rawText: "", stderr: "" };
        }
        return snippetResult({ name: "x", qualified_name: "q", file_path: "/abs/a.ts", start_line: 1, end_line: 2 });
      },
    } as unknown as CbmClient;
    const catalog = new ProjectCatalog(cbm);

    await catalog.relativizePaths({ file_path: "/abs/a.ts" }, "missing");
    await catalog.relativizePaths({ file_path: "/abs/a.ts" }, "missing");

    expect(listCalls).toBe(1);
  });
});
