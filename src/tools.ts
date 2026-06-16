import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildToolTextResult, callCbmTool, indexTimeoutMs, normalizePathForDisplay, queryTimeoutMs, removeUndefined, saveJsonResult } from "./cbm.js";
import { defaultRepoPath, inferProject, listProjects } from "./project.js";

const MODE = StringEnum(["full", "moderate", "fast", "cross-repo-intelligence"] as const);
const DIRECTION = StringEnum(["inbound", "outbound", "both"] as const);
const TRACE_MODE = StringEnum(["calls", "data_flow", "cross_service"] as const);
const SEARCH_CODE_MODE = StringEnum(["compact", "full", "files"] as const);
const ADR_MODE = StringEnum(["get", "update", "store", "sections"] as const);

const OPTIONAL_PROJECT = Type.Optional(Type.String({ description: "Indexed project name. If omitted, inferred from the current working directory." }));
const TIMEOUT_MS = Type.Optional(Type.Number({ description: "Timeout in milliseconds for this codebase-memory-mcp CLI call." }));
const FULL_OUTPUT = Type.Optional(
  Type.Boolean({ description: "Return complete code/source blocks. Default false; global safety truncation may still apply." }),
);
const MAX_SYMBOL_LINES = Type.Optional(
  Type.Number({
    default: 220,
    description:
      "Maximum lines to include per returned function, method, class, or symbol-sized code block before compacting. Default 220. Ignored when full_output=true.",
  }),
);
const OUTPUT_CONTROL_PARAMS = { full_output: FULL_OUTPUT, max_symbol_lines: MAX_SYMBOL_LINES };

const DEFAULT_MAX_SYMBOL_LINES = 220;
const MIN_MAX_SYMBOL_LINES = 40;
const MAX_MAX_SYMBOL_LINES = 2_000;
const COMPACTIBLE_CODE_KEYS = new Set(["context", "source", "code", "snippet", "source_code", "code_snippet", "raw_source"]);

type OutputControls = {
  fullOutput: boolean;
  maxSymbolLines: number;
};

type CompactedBlock = {
  text: string;
  originalLines: number;
  shownLines: number;
  strategy: "match_lines" | "head_tail";
};

type CompactionResult = {
  data: unknown;
  compacted: boolean;
};

async function withProject<T extends Record<string, unknown>>(params: T, ctx: ExtensionContext): Promise<Record<string, unknown>> {
  if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
  return removeUndefined({ ...params, project: await inferProject(ctx.cwd, ctx.signal) });
}

async function executeQueryTool(
  title: string,
  toolName: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  needsProject = true,
) {
  const upstreamParams = stripOutputControls(params);
  const args = needsProject ? await withProject(upstreamParams, ctx) : removeUndefined(upstreamParams);
  const result = await callCbmTool(toolName, args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
  return buildCompactableToolResult(title, result.data, params, { tool: toolName, args, stderr: result.stderr });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

function outputControls(params: Record<string, unknown>): OutputControls {
  return {
    fullOutput: params.full_output === true,
    maxSymbolLines: clampInt(params.max_symbol_lines, DEFAULT_MAX_SYMBOL_LINES, MIN_MAX_SYMBOL_LINES, MAX_MAX_SYMBOL_LINES),
  };
}

function stripOutputControls<T extends Record<string, unknown>>(params: T): Record<string, unknown> {
  return removeUndefined({ ...params, full_output: undefined, max_symbol_lines: undefined });
}

function isCompactibleCodeKey(key: string): boolean {
  return COMPACTIBLE_CODE_KEYS.has(key.toLowerCase());
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return JSON.stringify(value);
}

function isFunctionNotFound(value: unknown): boolean {
  return errorText(value).toLowerCase().includes("function not found");
}

type SearchCandidate = {
  name?: string;
  qualified_name?: string;
  label?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
};

function searchCandidates(data: unknown): SearchCandidate[] {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter((item): item is SearchCandidate => {
    if (!isRecord(item) || typeof item.qualified_name !== "string") return false;
    return item.label === "Function" || item.label === "Method" || item.label === undefined;
  });
}

function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const result: SearchCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.qualified_name || seen.has(candidate.qualified_name)) continue;
    seen.add(candidate.qualified_name);
    result.push(candidate);
  }
  return result;
}

function tracePathFromItem(item: Record<string, unknown>): string {
  for (const key of ["file_path", "file", "path", "qualified_name"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

function filterTraceData(data: unknown, params: Record<string, unknown>): unknown {
  const excludePaths = Array.isArray(params.exclude_paths) ? params.exclude_paths.filter((item): item is string => typeof item === "string") : [];
  if (excludePaths.length === 0) return data;

  const shouldExclude = (item: Record<string, unknown>): boolean => {
    const path = tracePathFromItem(item);
    if (!path) return false;
    return excludePaths.some((excluded) => path.includes(excluded));
  };

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !isRecord(item) || !shouldExclude(item)).map(visit);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };

  return visit(data);
}

function upstreamTraceParams(params: Record<string, unknown>): Record<string, unknown> {
  return stripOutputControls(removeUndefined({ ...params, exclude_paths: undefined }));
}

function getMatchLines(container: Record<string, unknown>): number[] {
  if (!Array.isArray(container.match_lines)) return [];
  return container.match_lines.filter((line): line is number => typeof line === "number" && Number.isFinite(line));
}

function getStartLine(container: Record<string, unknown>): number | undefined {
  if (typeof container.start_line === "number" && Number.isFinite(container.start_line)) return container.start_line;
  if (typeof container.line === "number" && Number.isFinite(container.line)) return container.line;
  return undefined;
}

function rangesFromSelectedIndexes(indexes: number[]): Array<[number, number]> {
  if (indexes.length === 0) return [];
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0]!;
  let end = sorted[0]!;

  for (const index of sorted.slice(1)) {
    if (index === end + 1) {
      end = index;
      continue;
    }
    ranges.push([start, end]);
    start = index;
    end = index;
  }
  ranges.push([start, end]);
  return ranges;
}

function renderRanges(lines: string[], ranges: Array<[number, number]>): { text: string; shownLines: number } {
  const output: string[] = [];
  let previousEnd = -1;

  for (const [start, end] of ranges) {
    const omitted = start - previousEnd - 1;
    if (omitted > 0) output.push(`[... omitted ${omitted} line${omitted === 1 ? "" : "s"} ...]`);
    output.push(...lines.slice(start, end + 1));
    previousEnd = end;
  }

  const trailing = lines.length - previousEnd - 1;
  if (trailing > 0) output.push(`[... omitted ${trailing} line${trailing === 1 ? "" : "s"} ...]`);

  return { text: output.join("\n"), shownLines: output.length };
}

function compactByMatches(lines: string[], container: Record<string, unknown>, maxLines: number): CompactedBlock | undefined {
  const startLine = getStartLine(container);
  const matchLines = getMatchLines(container);
  if (startLine === undefined || matchLines.length === 0) return undefined;

  const selected = new Set<number>();
  const radius = 4;
  for (const matchLine of matchLines) {
    const index = matchLine - startLine;
    if (index < 0 || index >= lines.length) continue;
    for (let selectedIndex = Math.max(0, index - radius); selectedIndex <= Math.min(lines.length - 1, index + radius); selectedIndex++) {
      selected.add(selectedIndex);
    }
    if (selected.size >= maxLines) break;
  }

  if (selected.size === 0) return undefined;
  const prioritized = [...selected];
  let selectedLineCount = Math.min(prioritized.length, maxLines);
  let rendered = renderRanges(lines, rangesFromSelectedIndexes(prioritized.slice(0, selectedLineCount)));

  while (rendered.shownLines > maxLines && selectedLineCount > 1) {
    selectedLineCount = Math.max(1, selectedLineCount - (rendered.shownLines - maxLines));
    rendered = renderRanges(lines, rangesFromSelectedIndexes(prioritized.slice(0, selectedLineCount)));
  }

  return { text: rendered.text, originalLines: lines.length, shownLines: rendered.shownLines, strategy: "match_lines" };
}

function compactHeadTail(lines: string[], maxLines: number): CompactedBlock {
  const markerLines = 1;
  const sourceLineBudget = Math.max(2, maxLines - markerLines);
  const headLines = Math.max(1, Math.ceil(sourceLineBudget * 0.6));
  const tailLines = Math.max(1, sourceLineBudget - headLines);
  const omitted = Math.max(0, lines.length - headLines - tailLines);
  const output = [...lines.slice(0, headLines), `[... omitted ${omitted} line${omitted === 1 ? "" : "s"} ...]`, ...lines.slice(lines.length - tailLines)];
  return { text: output.join("\n"), originalLines: lines.length, shownLines: output.length, strategy: "head_tail" };
}

function compactCodeBlock(value: string, container: Record<string, unknown>, controls: OutputControls): CompactedBlock | undefined {
  if (controls.fullOutput) return undefined;
  const lines = value.split(/\r?\n/);
  if (lines.length <= controls.maxSymbolLines) return undefined;
  return compactByMatches(lines, container, controls.maxSymbolLines) ?? compactHeadTail(lines, controls.maxSymbolLines);
}

function compactSymbolBlocks(value: unknown, controls: OutputControls): CompactionResult {
  let compacted = false;

  const visit = (entry: unknown, container: Record<string, unknown> | undefined, key: string | undefined): unknown => {
    if (typeof entry === "string" && container && key && isCompactibleCodeKey(key)) {
      const block = compactCodeBlock(entry, container, controls);
      if (!block) return entry;
      compacted = true;
      container[`${key}_compacted`] = true;
      container[`${key}_original_lines`] = block.originalLines;
      container[`${key}_shown_lines`] = block.shownLines;
      container[`${key}_compaction_strategy`] = block.strategy;
      container[`${key}_hint`] = "Increase max_symbol_lines or set full_output=true to include the complete block.";
      return block.text;
    }

    if (Array.isArray(entry)) return entry.map((item) => visit(item, undefined, undefined));
    if (!isRecord(entry)) return entry;

    if (Array.isArray(entry.columns) && Array.isArray(entry.rows)) {
      const columns = entry.columns.map((column) => (typeof column === "string" ? column : ""));
      const compactibleIndexes = columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => isCompactibleCodeKey(column));

      if (compactibleIndexes.length > 0) {
        const cellCompactions: Array<Record<string, unknown>> = [];
        const rows = entry.rows.map((row, rowIndex) => {
          if (!Array.isArray(row)) return row;
          const rowContainer = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
          const nextRow = [...row];

          for (const { column, index } of compactibleIndexes) {
            const cell = nextRow[index];
            if (typeof cell !== "string") continue;
            const block = compactCodeBlock(cell, rowContainer, controls);
            if (!block) continue;
            compacted = true;
            nextRow[index] = block.text;
            cellCompactions.push({ row: rowIndex, column, original_lines: block.originalLines, shown_lines: block.shownLines, strategy: block.strategy });
          }

          return nextRow;
        });

        if (cellCompactions.length > 0) {
          return {
            ...entry,
            rows,
            _symbol_compactions: cellCompactions,
            _symbol_compaction_hint: "Increase max_symbol_lines or set full_output=true to include complete code blocks.",
          };
        }
      }
    }

    const clone: Record<string, unknown> = { ...entry };
    for (const [childKey, childValue] of Object.entries(clone)) {
      clone[childKey] = visit(childValue, clone, childKey);
    }
    return clone;
  };

  return { data: visit(value, undefined, undefined), compacted };
}

async function buildCompactableToolResult(
  title: string,
  data: unknown,
  params: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  const controls = outputControls(params);
  const compaction = compactSymbolBlocks(data, controls);
  const resultDetails: Record<string, unknown> = {
    ...details,
    full_output: controls.fullOutput,
    max_symbol_lines: controls.maxSymbolLines,
  };

  if (compaction.compacted) {
    resultDetails.uncompactedOutputPath = await saveJsonResult(data, "result.uncompacted.json");
    resultDetails.symbolCompaction = {
      max_symbol_lines: controls.maxSymbolLines,
      hint: "Increase max_symbol_lines or set full_output=true to include complete code blocks.",
    };
  }

  return buildToolTextResult(title, compaction.data, resultDetails);
}

const NUMERIC_QUERY_COLUMNS = new Set([
  "complexity",
  "cognitive",
  "lines",
  "line",
  "start_line",
  "end_line",
  "param_count",
  "in_degree",
  "out_degree",
  "fan_in",
  "fan_out",
  "degree",
  "count",
  "total",
  "nodes",
  "edges",
  "size_bytes",
  "hop",
  "depth",
]);

function coerceQueryGraphMetrics(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return data;
  const columns = data.columns.map((column) => (typeof column === "string" ? column.toLowerCase() : ""));
  const rows = data.rows.map((row) => {
    if (!Array.isArray(row)) return row;
    return row.map((value, index) => {
      if (!NUMERIC_QUERY_COLUMNS.has(columns[index] ?? "")) return value;
      if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) return value;
      return Number(value);
    });
  });
  return { ...data, rows };
}

async function findTraceCandidates(functionName: string, project: string, ctx: ExtensionContext): Promise<SearchCandidate[]> {
  const escapedName = escapeRegExp(functionName);
  const shortName = functionName.split(".").at(-1) ?? functionName;
  const escapedShortName = escapeRegExp(shortName);
  const searches = [
    { qn_pattern: `.*${escapedName}.*` },
    { name_pattern: `^${escapedShortName}$` },
    { name_pattern: `.*${escapedShortName}.*` },
  ];

  const candidates: SearchCandidate[] = [];
  for (const search of searches) {
    const result = await callCbmTool(
      "search_graph",
      { project, limit: 10, ...search },
      { signal: ctx.signal, timeoutMs: queryTimeoutMs(undefined), allowError: true },
    );
    if (!result.ok) continue;
    const batch = dedupeCandidates(searchCandidates(result.data));
    if (batch.length === 1) return batch;
    candidates.push(...batch);
  }

  return dedupeCandidates(candidates).slice(0, 10);
}

async function executeTracePath(params: Record<string, unknown>, ctx: ExtensionContext) {
  const args = await withProject(upstreamTraceParams(params), ctx);
  const project = String(args.project ?? "");
  const functionName = String(args.function_name ?? "");
  const result = await callCbmTool("trace_path", args, {
    signal: ctx.signal,
    timeoutMs: queryTimeoutMs(params.timeout_ms),
    allowError: true,
  });

  if (result.ok) {
    return buildCompactableToolResult("Trace path results", filterTraceData(result.data, params), params, { tool: "trace_path", args, stderr: result.stderr });
  }
  if (!isFunctionNotFound(result.data) || !functionName || !project) throw new Error(errorText(result.data));

  const candidates = await findTraceCandidates(functionName, project, ctx);
  if (candidates.length === 1 && candidates[0]?.qualified_name) {
    const resolvedArgs = { ...args, function_name: candidates[0].qualified_name };
    const resolved = await callCbmTool("trace_path", resolvedArgs, {
      signal: ctx.signal,
      timeoutMs: queryTimeoutMs(params.timeout_ms),
    });
    return buildCompactableToolResult("Trace path results", filterTraceData(resolved.data, params), params, {
      tool: "trace_path",
      args: resolvedArgs,
      resolved_from: functionName,
      stderr: `${result.stderr}${resolved.stderr}`,
    });
  }

  return buildToolTextResult(
    "Trace target candidates",
    {
      error: "function not found",
      hint:
        candidates.length > 1
          ? "Multiple possible trace targets found. Retry trace_path with one exact qualified_name."
          : "No matching Function/Method candidates found. Use search_graph to find the exact qualified_name.",
      function_name: functionName,
      candidates,
    },
    { tool: "trace_path", args, stderr: result.stderr },
  );
}

async function executeQueryGraph(params: Record<string, unknown>, ctx: ExtensionContext) {
  const args = await withProject(stripOutputControls({ max_rows: 200, ...params }), ctx);
  const result = await callCbmTool("query_graph", args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
  return buildCompactableToolResult("Cypher query results", coerceQueryGraphMetrics(result.data), params, {
    tool: "query_graph",
    args,
    stderr: result.stderr,
    numeric_metrics_normalized: true,
  });
}

function renderCall(label: string, pick: (args: Record<string, unknown>) => string | undefined = () => undefined) {
  return (args: Record<string, unknown>, theme: any) => {
    const suffix = pick(args);
    return new Text(`${theme.fg("toolTitle", theme.bold(`${label} `))}${suffix ? theme.fg("accent", suffix) : ""}`, 0, 0);
  };
}

function renderResult(label: string) {
  return (result: { details?: Record<string, unknown> }, _options: unknown, theme: any) => {
    const details = result.details ?? {};
    const args = details.args as Record<string, unknown> | undefined;
    const data = details.data as Record<string, unknown> | undefined;
    const bits: string[] = [theme.fg("success", `✓ ${label}`)];
    if (args?.project) bits.push(theme.fg("muted", `project=${String(args.project)}`));
    if (typeof data?.total === "number") bits.push(theme.fg("muted", `total=${data.total}`));
    if (typeof data?.has_more === "boolean" && data.has_more) bits.push(theme.fg("warning", "has_more"));
    if (details.fullOutputPath) bits.push(theme.fg("warning", `full=${String(details.fullOutputPath)}`));
    if (details.uncompactedOutputPath) bits.push(theme.fg("warning", `uncompacted=${String(details.uncompactedOutputPath)}`));
    return new Text(bits.join(" "), 0, 0);
  };
}

export function registerCodebaseMemoryTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_projects",
    label: "CBM Projects",
    description: "List codebase-memory-mcp indexed projects. Use before querying if project name is unknown.",
    promptSnippet: "list_projects(): list indexed codebase-memory projects and their root paths",
    promptGuidelines: ["Use list_projects when a codebase-memory project name is unknown or a query reports that the project is not indexed."],
    parameters: Type.Object({ timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: { timeout_ms?: number }, signal) {
      const projects = await listProjects(signal);
      return buildToolTextResult("Indexed codebase-memory projects", { projects }, { tool: "list_projects" });
    },
    renderCall: renderCall("list_projects"),
    renderResult: renderResult("list_projects"),
  });

  pi.registerTool({
    name: "index_repository",
    label: "CBM Index",
    description:
      "Index an external repository or manually refresh a repository graph. The current cwd git root is auto-indexed in full mode at startup and periodically refreshed, so this is usually unnecessary for the active project.",
    promptSnippet: "index_repository(repo_path?, mode?): index an external repository or manually refresh a graph",
    promptGuidelines: [
      "The plugin automatically indexes the current cwd project in full mode at startup and periodically refreshes it in the background; do not call index_repository for the active project unless an explicit manual refresh is needed.",
      "Use index_repository mainly for external repository paths that are not the current cwd project.",
      "Prefer the default mode='full' unless you explicitly need a faster, lower-fidelity refresh.",
    ],
    parameters: Type.Object({
      repo_path: Type.Optional(Type.String({ description: "Repository path. Defaults to current git root." })),
      mode: Type.Optional(MODE),
      target_projects: Type.Optional(Type.Array(Type.String())),
      persistence: Type.Optional(Type.Boolean({ description: "Write .codebase-memory/graph.db.zst for team sharing. Default false." })),
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, signal, onUpdate, ctx) {
      const repoPath = typeof params.repo_path === "string" && params.repo_path.trim() ? params.repo_path : await defaultRepoPath(ctx.cwd, signal);
      const args = removeUndefined({
        repo_path: repoPath,
        mode: params.mode ?? "full",
        target_projects: params.target_projects,
        persistence: params.persistence,
      });
      onUpdate?.({ content: [{ type: "text", text: `Indexing ${normalizePathForDisplay(repoPath)}...` }], details: { args } });
      const result = await callCbmTool("index_repository", args, { signal, timeoutMs: indexTimeoutMs(params.timeout_ms) });
      return buildToolTextResult("Indexed repository", result.data, { tool: "index_repository", args, stderr: result.stderr });
    },
    renderCall: renderCall("index_repository", (args) => (typeof args.repo_path === "string" ? normalizePathForDisplay(args.repo_path) : "current repo")),
    renderResult: renderResult("index_repository"),
  });

  pi.registerTool({
    name: "search_graph",
    label: "CBM Search Graph",
    description:
      "Search codebase-memory's knowledge graph for functions, methods, classes, routes, variables, and semantic concepts. Prefer this over grep/find for symbol discovery.",
    promptSnippet: "search_graph(query/name_pattern/semantic_query, project?): structural and semantic code graph search",
    promptGuidelines: [
      "Use search_graph before get_code_snippet to discover the exact qualified_name for symbols.",
      "Use search_graph instead of grep/find when looking for functions, classes, routes, implementations, handlers, or semantically related code.",
      "Prefer query/name_pattern/file_pattern search first; semantic_query can be noisy, especially on small repos.",
      "For semantic_query, pass an array of keyword strings, not one sentence string.",
    ],
    parameters: Type.Object({
      project: OPTIONAL_PROJECT,
      query: Type.Optional(Type.String({ description: "Natural-language or keyword BM25 graph search." })),
      label: Type.Optional(Type.String()),
      name_pattern: Type.Optional(Type.String({ description: "Regex name pattern, e.g. .*Handler.*" })),
      qn_pattern: Type.Optional(Type.String()),
      file_pattern: Type.Optional(Type.String()),
      relationship: Type.Optional(Type.String()),
      min_degree: Type.Optional(Type.Number()),
      max_degree: Type.Optional(Type.Number()),
      exclude_entry_points: Type.Optional(Type.Boolean()),
      include_connected: Type.Optional(Type.Boolean()),
      semantic_query: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number({ default: 25 })),
      offset: Type.Optional(Type.Number({ default: 0 })),
      ...OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
      return executeQueryTool("Graph search results", "search_graph", { limit: 25, ...params }, ctx);
    },
    renderCall: renderCall("search_graph", (args) => String(args.query ?? args.name_pattern ?? args.semantic_query ?? "")),
    renderResult: renderResult("search_graph"),
  });

  pi.registerTool({
    name: "get_code_snippet",
    label: "CBM Snippet",
    description: "Read source code for a symbol by qualified_name. First use search_graph to find the exact qualified_name.",
    promptSnippet: "get_code_snippet(qualified_name, project?): read precise source for a graph symbol",
    promptGuidelines: [
      "Use get_code_snippet only after search_graph identifies the qualified_name; it is a retrieval tool, not a search tool.",
      "If an oversized symbol is compacted, increase max_symbol_lines or set full_output=true only when the complete block is needed in context.",
    ],
    parameters: Type.Object({
      qualified_name: Type.String({ description: "Full qualified_name from search_graph, or a short name if unambiguous." }),
      project: OPTIONAL_PROJECT,
      include_neighbors: Type.Optional(Type.Boolean()),
      ...OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Code snippet", "get_code_snippet", params, ctx);
    },
    renderCall: renderCall("get_code_snippet", (args) => String(args.qualified_name ?? "")),
    renderResult: renderResult("get_code_snippet"),
  });

  pi.registerTool({
    name: "trace_path",
    label: "CBM Trace",
    description: "Trace callers/callees, data flow, or cross-service paths through the code graph. Use for impact and dependency analysis.",
    promptSnippet: "trace_path(function_name, direction?, mode?): trace callers, callees, data-flow, or cross-service paths",
    promptGuidelines: [
      "Use trace_path for caller/callee questions, dependency tracing, data-flow tracing, and impact analysis instead of repeated grep.",
      "Short names are auto-resolved when unambiguous; if multiple candidates are returned, retry with an exact qualified_name.",
      "risk_labels are heuristic and can be noisy; request them only for explicit risk/impact analysis.",
    ],
    parameters: Type.Object({
      function_name: Type.String(),
      project: OPTIONAL_PROJECT,
      direction: Type.Optional(DIRECTION),
      depth: Type.Optional(Type.Number({ default: 3 })),
      mode: Type.Optional(TRACE_MODE),
      parameter_name: Type.Optional(Type.String()),
      edge_types: Type.Optional(Type.Array(Type.String())),
      risk_labels: Type.Optional(Type.Boolean({ description: "Heuristic risk labels. Default false; can be noisy." })),
      include_tests: Type.Optional(Type.Boolean()),
      exclude_paths: Type.Optional(Type.Array(Type.String({ description: "Plugin-side substring filters for file paths or qualified names in trace results." }))),
      ...OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeTracePath(params, ctx);
    },
    renderCall: renderCall("trace_path", (args) => `${String(args.function_name ?? "")} ${String(args.direction ?? "both")}`),
    renderResult: renderResult("trace_path"),
  });

  pi.registerTool({
    name: "get_architecture",
    label: "CBM Architecture",
    description: "Get high-level codebase architecture: packages, entry points, hotspots, routes, clusters, and dependencies.",
    promptSnippet: "get_architecture(project?, aspects?): high-level codebase architecture overview",
    promptGuidelines: [
      "Use get_architecture early when orienting yourself in an indexed codebase.",
      "For large repos, prefer targeted aspects such as entry_points, hotspots, dependencies, or layers instead of requesting everything.",
    ],
    parameters: Type.Object({ project: OPTIONAL_PROJECT, aspects: Type.Optional(Type.Array(Type.String())), ...OUTPUT_CONTROL_PARAMS, timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Architecture overview", "get_architecture", params, ctx);
    },
    renderCall: renderCall("get_architecture"),
    renderResult: renderResult("get_architecture"),
  });

  pi.registerTool({
    name: "get_graph_schema",
    label: "CBM Schema",
    description: "Get codebase-memory graph schema: node labels, edge types, and properties for a project.",
    promptSnippet: "get_graph_schema(project?): inspect available graph labels, edge types, and properties",
    promptGuidelines: ["Use get_graph_schema before writing non-trivial query_graph Cypher."],
    parameters: Type.Object({ project: OPTIONAL_PROJECT, timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Graph schema", "get_graph_schema", params, ctx);
    },
    renderCall: renderCall("get_graph_schema"),
    renderResult: renderResult("get_graph_schema"),
  });

  pi.registerTool({
    name: "query_graph",
    label: "CBM Query Graph",
    description: "Execute read-only Cypher against the codebase-memory graph for complex multi-hop or aggregate questions.",
    promptSnippet: "query_graph(query, project?): run read-only Cypher over the code graph",
    promptGuidelines: [
      "Use query_graph for complex multi-hop graph questions after checking get_graph_schema. Prefer search_graph for simple symbol discovery.",
      "codebase-memory query_graph supports a Cypher-like subset, not necessarily full Neo4j Cypher; prefer simple MATCH patterns.",
      "Treat numeric sorting/ranking queries cautiously: the plugin normalizes common numeric result values for display, but upstream query ordering may still be unreliable.",
    ],
    parameters: Type.Object({ query: Type.String(), project: OPTIONAL_PROJECT, max_rows: Type.Optional(Type.Number({ default: 200 })), ...OUTPUT_CONTROL_PARAMS, timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryGraph(params, ctx);
    },
    renderCall: renderCall("query_graph", (args) => String(args.query ?? "").slice(0, 80)),
    renderResult: renderResult("query_graph"),
  });

  pi.registerTool({
    name: "search_code",
    label: "CBM Search Code",
    description: "Graph-augmented text search over indexed files. Use when literal text/regex search is needed, with graph-ranked enrichment.",
    promptSnippet: "search_code(pattern, project?): grep-like search enriched with graph context",
    promptGuidelines: [
      "Use search_code for literal text/regex search in indexed files; use search_graph for symbol/semantic discovery.",
      "Oversized per-symbol contexts are compacted by default; increase max_symbol_lines or set full_output=true when complete large blocks are necessary.",
    ],
    parameters: Type.Object({
      pattern: Type.String(),
      project: OPTIONAL_PROJECT,
      file_pattern: Type.Optional(Type.String()),
      path_filter: Type.Optional(Type.String()),
      mode: Type.Optional(SEARCH_CODE_MODE),
      context: Type.Optional(Type.Number()),
      regex: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ default: 10 })),
      ...OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Code search results", "search_code", { mode: "compact", context: 2, limit: 10, ...params }, ctx);
    },
    renderCall: renderCall("search_code", (args) => String(args.pattern ?? "")),
    renderResult: renderResult("search_code"),
  });

  pi.registerTool({
    name: "index_status",
    label: "CBM Index Status",
    description: "Check indexing status for an inferred or explicit codebase-memory project.",
    promptSnippet: "index_status(project?): check whether a project is indexed",
    parameters: Type.Object({ project: OPTIONAL_PROJECT, timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Index status", "index_status", params, ctx);
    },
    renderCall: renderCall("index_status"),
    renderResult: renderResult("index_status"),
  });

  pi.registerTool({
    name: "detect_changes",
    label: "CBM Detect Changes",
    description: "Map git changes to affected symbols and blast radius with risk classification.",
    promptSnippet: "detect_changes(project?, depth?, base_branch?/since?): graph impact analysis for local changes",
    promptGuidelines: ["Use detect_changes when reviewing local diffs or estimating blast radius before editing or committing."],
    parameters: Type.Object({
      project: OPTIONAL_PROJECT,
      scope: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Number({ default: 2 })),
      base_branch: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      ...OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Change impact results", "detect_changes", params, ctx);
    },
    renderCall: renderCall("detect_changes"),
    renderResult: renderResult("detect_changes"),
  });

  pi.registerTool({
    name: "manage_adr",
    label: "CBM ADR",
    description: "Get, update, or inspect Architecture Decision Records managed by codebase-memory.",
    promptSnippet: "manage_adr(project?, mode, content?/sections?): persist or retrieve architecture decisions",
    promptGuidelines: [
      "mode='update' writes persistent ADR state.",
      "mode='store' is accepted as a compatibility alias for mode='update'.",
    ],
    parameters: Type.Object({
      project: OPTIONAL_PROJECT,
      mode: ADR_MODE,
      content: Type.Optional(Type.String()),
      sections: Type.Optional(Type.Array(Type.String())),
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      const mode = params.mode === "store" ? "update" : params.mode;
      if (mode === "update" && typeof params.content !== "string") throw new Error("manage_adr mode='update' requires content.");
      const normalized = removeUndefined({ ...params, mode });
      return executeQueryTool("ADR result", "manage_adr", normalized, ctx);
    },
    renderCall: renderCall("manage_adr", (args) => String(args.mode ?? "")),
    renderResult: renderResult("manage_adr"),
  });

  pi.registerTool({
    name: "ingest_traces",
    label: "CBM Ingest Traces",
    description: "Ingest runtime traces into codebase-memory. Experimental: current codebase-memory versions may accept traces without creating graph edges.",
    promptSnippet: "ingest_traces(project?, traces): ingest runtime traces into the code graph",
    promptGuidelines: ["Use ingest_traces only when explicitly testing runtime trace ingestion; it may not enrich the graph yet."],
    parameters: Type.Object({ project: OPTIONAL_PROJECT, traces: Type.Array(Type.Object({})), timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Trace ingestion result", "ingest_traces", params, ctx);
    },
    renderCall: renderCall("ingest_traces"),
    renderResult: renderResult("ingest_traces"),
  });

  pi.registerTool({
    name: "delete_project",
    label: "CBM Delete Project",
    description: "Delete an indexed codebase-memory project. Requires confirm_project_name equal to project.",
    parameters: Type.Object({ project: OPTIONAL_PROJECT, confirm_project_name: Type.String(), timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      const args = await withProject(params, ctx);
      const project = String(args.project ?? "");
      if (params.confirm_project_name !== project) throw new Error("confirm_project_name must exactly match project.");
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Delete codebase-memory project?", `Delete indexed project '${project}'?`);
        if (!ok) throw new Error("delete_project cancelled by user");
      }
      const result = await callCbmTool("delete_project", { project }, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
      return buildToolTextResult("Deleted project", result.data, { tool: "delete_project", args, stderr: result.stderr });
    },
    renderCall: renderCall("delete_project", (args) => String(args.project ?? "")),
    renderResult: renderResult("delete_project"),
  });
}
