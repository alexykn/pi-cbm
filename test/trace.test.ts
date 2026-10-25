import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { CbmClient } from "../src/cbm/client.js";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver, type ToolExecutionContext } from "../src/domain/project-resolver.js";
import { SymbolService } from "../src/domain/symbols.js";
import { TraceService } from "../src/domain/trace.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);
const PROJECT = "tmp-cbm-fixture-repo";
const ROOT = "/tmp/cbm-fixture-repo";
const CTX: ToolExecutionContext = { cwd: ROOT };

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

/** Distinct per-module paths so an exclude_paths filter keeps some rows and drops others. */
function fileFromQn(qualifiedName: string): string {
  return qualifiedName.includes(".cbm.") ? "src/cbm/envelope.ts" : "src/domain/symbols.ts";
}

/** The real tool echoes the requested qn; the mock does the same so enrichment stays truthful. */
function snippetFor(args: Record<string, unknown>): CbmCallResult {
  const qualifiedName = String(args.qualified_name ?? "");
  return {
    ok: true,
    data: {
      name: qualifiedName.split(".").at(-1) ?? qualifiedName,
      qualified_name: qualifiedName,
      label: "Method",
      file_path: `${ROOT}/${fileFromQn(qualifiedName)}`,
      start_line: 1,
      end_line: 2,
      source: "x",
    },
    rawText: "",
    stderr: "",
  };
}

function fakeClient(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): CbmClient {
  return {
    callTool: async (tool: string, args: Record<string, unknown>) =>
      tool === "list_projects" ? fixture("list_projects.format-flag") : handler(tool, args),
  } as unknown as CbmClient;
}

function traceService(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): TraceService {
  const cbm = fakeClient(handler);
  const catalog = new ProjectCatalog(cbm);
  const resolver = new ProjectResolver(cbm, catalog);
  const output = new OutputService();
  return new TraceService(cbm, resolver, output, new SymbolService(cbm, resolver, catalog, output));
}

function handlerWithTrace(traceResult: (args: Record<string, unknown>) => CbmCallResult) {
  return (tool: string, args: Record<string, unknown>): CbmCallResult => {
    if (tool === "trace_path") return traceResult(args);
    if (tool === "get_code_snippet") return snippetFor(args);
    if (tool === "search_graph") return fixture("search_graph.name-pattern");
    throw new Error(`unexpected cbm tool: ${tool}`);
  };
}

describe("TraceService on cbm 0.12 shapes", () => {
  it("feeds the normalized caller/callee arrays through and enriches their locations", async () => {
    const service = traceService(handlerWithTrace(() => fixture("trace_path.depth1")));
    const result = await service.trace({ function_name: "callTool", project: PROJECT }, CTX);
    const data = result.details.data as Record<string, unknown>;

    const callers = data.callers as Array<Record<string, unknown>>;
    expect(callers.some((item) => item.qualified_name === "tmp-cbm-fixture-repo.src.domain.symbols.SymbolService.fetchSymbolLocation")).toBe(true);
    expect(callers.every((item) => item.file_path === "src/domain/symbols.ts")).toBe(true);

    const callees = data.callees as Array<Record<string, unknown>>;
    expect(callees.some((item) => item.qualified_name === "tmp-cbm-fixture-repo.src.cbm.envelope.parseMaybeJson")).toBe(true);
    expect(callees.some((item) => item.file_path === "src/cbm/envelope.ts")).toBe(true);
    expect(callees.some((item) => item.file_path === "src/domain/symbols.ts")).toBe(true);
    expect(data.callers_total).toBe(11);
    expect(data.callees_total).toBe(6);
  });

  it("retries a function-not-found trace with the qualified name found by search_graph", async () => {
    const service = traceService(
      handlerWithTrace((args) => (args.function_name === "noSuchFunction" ? fixture("trace_path.unknown") : fixture("trace_path.depth1"))),
    );
    const result = await service.trace({ function_name: "noSuchFunction", project: PROJECT }, CTX);

    expect(result.details.resolved_from).toBe("noSuchFunction");
    expect((result.details.args as Record<string, unknown>).function_name).toBe("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool");
    expect((result.details.data as Record<string, unknown>).callers_total).toBe(11);
  });

  it("surfaces a failed lookup during the function-not-found retry", async () => {
    const service = traceService((tool) => {
      if (tool === "trace_path") return fixture("trace_path.unknown");
      if (tool === "search_graph") return fixture("search_graph.unknown-project");
      throw new Error(`unexpected cbm tool: ${tool}`);
    });

    await expect(service.trace({ function_name: "noSuchFunction", project: PROJECT }, CTX)).rejects.toThrow(/project not found or not indexed/);
  });

  it("tolerates a partial search_graph failure during the retry", async () => {
    let searches = 0;
    const service = traceService((tool, args) => {
      if (tool === "trace_path") return args.function_name === "noSuchFunction" ? fixture("trace_path.unknown") : fixture("trace_path.depth1");
      if (tool === "search_graph") {
        searches += 1;
        return searches === 1 ? fixture("search_graph.unknown-project") : fixture("search_graph.name-pattern");
      }
      if (tool === "get_code_snippet") return snippetFor(args);
      throw new Error(`unexpected cbm tool: ${tool}`);
    });

    const result = await service.trace({ function_name: "noSuchFunction", project: PROJECT }, CTX);
    expect(result.details.resolved_from).toBe("noSuchFunction");
  });

  it("applies exclude_paths after locations are enriched, keeping unexcluded rows", async () => {
    const service = traceService(handlerWithTrace(() => fixture("trace_path.depth1")));
    const result = await service.trace({ function_name: "callTool", project: PROJECT, exclude_paths: ["src/cbm/"] }, CTX);
    const data = result.details.data as Record<string, unknown>;

    const callers = data.callers as Array<Record<string, unknown>>;
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.every((item) => !String(item.file_path).includes("src/cbm/"))).toBe(true);

    const callees = data.callees as Array<Record<string, unknown>>;
    expect(callees.length).toBeGreaterThan(0);
    expect(callees.every((item) => !String(item.file_path).includes("src/cbm/"))).toBe(true);
    expect(data.truncation_hint).toContain("callees");
  });

  it("caps enrichment and marks the nodes it could not locate", async () => {
    const callers = Array.from({ length: 60 }, (_, index) => ({ name: `caller${index}`, hop: 1, qualified_name: `proj.src.mod.caller${index}` }));
    let snippets = 0;
    const service = traceService((tool, args) => {
      if (tool === "trace_path") return { ok: true, data: { function: "f", callers, callers_total: 60 }, rawText: "", stderr: "" };
      if (tool === "get_code_snippet") {
        snippets += 1;
        return snippetFor(args);
      }
      throw new Error(`unexpected cbm tool: ${tool}`);
    });

    const result = await service.trace({ function_name: "f", project: PROJECT }, CTX);
    const data = result.details.data as Record<string, unknown>;

    expect(snippets).toBe(50);
    expect(data.location_enrichment).toMatchObject({ located: 50, unlocated: 10 });
    expect((data.callers as unknown[]).length).toBe(60);
  });
});
