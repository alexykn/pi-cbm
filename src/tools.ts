import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildToolTextResult, callCbmTool, queryTimeoutMs, removeUndefined, saveJsonResult } from "./cbm.js";
import { inferProject } from "./project.js";

const DIRECTION = StringEnum(["inbound", "outbound", "both"] as const);
const TRACE_MODE = StringEnum(["calls", "data_flow", "cross_service"] as const);
const SEARCH_CODE_MODE = StringEnum(["compact", "full", "files"] as const);
const SYMBOL_LABEL = StringEnum(["Function", "Method", "Class", "Variable", "Type", "Route"] as const);
const SYMBOL_NEIGHBORS = StringEnum(["none", "callers", "callees", "both"] as const);

const OPTIONAL_PROJECT = Type.Optional(Type.String({ description: "Indexed project name. If omitted, inferred from the current working directory." }));
const TIMEOUT_MS = Type.Optional(Type.Number({ description: "Timeout in milliseconds for this codebase-memory-mcp CLI call." }));
const FULL_OUTPUT = Type.Optional(
  Type.Boolean({
    description:
      "Return complete per-symbol code/source blocks. Use this if a prior result was compacted and the full function/class is needed. Default false; global safety truncation may still apply.",
  }),
);
const INCLUDE_METADATA = Type.Optional(
  Type.Boolean({
    description:
      "Include full upstream graph metrics, fingerprints, token fields, and raw metadata. Default false keeps output compact and location-first for context-efficient exploration.",
  }),
);
const MAX_SYMBOL_LINES = Type.Optional(
  Type.Number({
    default: 220,
    description:
      "Maximum lines to include per returned function, method, class, or symbol-sized code block before compacting. Default 220. Ignored when full_output=true.",
  }),
);
const OUTPUT_CONTROL_PARAMS = { full_output: FULL_OUTPUT, max_symbol_lines: MAX_SYMBOL_LINES };
const EXPLORATION_OUTPUT_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA, ...OUTPUT_CONTROL_PARAMS };
const METADATA_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA };

const DEFAULT_MAX_SYMBOL_LINES = 220;
const MIN_MAX_SYMBOL_LINES = 40;
const MAX_MAX_SYMBOL_LINES = 2_000;
const COMPACTIBLE_CODE_KEYS = new Set(["context", "source", "code", "snippet", "source_code", "code_snippet", "raw_source"]);

type OutputControls = {
  fullOutput: boolean;
  includeMetadata: boolean;
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
  const project = typeof args.project === "string" ? args.project : "";
  const data = project && (toolName === "search_graph" || toolName === "get_architecture" || toolName === "detect_changes")
    ? await enrichTraceLocations(result.data, project, params, ctx)
    : result.data;
  return buildCompactableToolResult(title, data, params, { tool: toolName, args, stderr: result.stderr });
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
    includeMetadata: params.include_metadata === true,
    maxSymbolLines: clampInt(params.max_symbol_lines, DEFAULT_MAX_SYMBOL_LINES, MIN_MAX_SYMBOL_LINES, MAX_MAX_SYMBOL_LINES),
  };
}

function stripOutputControls<T extends Record<string, unknown>>(params: T): Record<string, unknown> {
  return removeUndefined({ ...params, include_metadata: undefined, full_output: undefined, max_symbol_lines: undefined });
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
  parent_class?: string;
  signature?: string;
  return_type?: string;
  route_path?: string;
  route_method?: string;
  [key: string]: unknown;
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

function allSearchCandidates(data: unknown): SearchCandidate[] {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter((item): item is SearchCandidate => isRecord(item) && typeof item.qualified_name === "string");
}

function normalizeForMatch(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function stringProp(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function candidateFilePath(candidate: SearchCandidate): string | undefined {
  return stringProp(candidate, "file_path") ?? stringProp(candidate, "file") ?? stringProp(candidate, "path");
}

function numberProp(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function candidateRouteMethod(candidate: SearchCandidate): string | undefined {
  return stringProp(candidate, "route_method") ?? stringProp(candidate, "http_method") ?? stringProp(candidate, "method");
}

function candidateMatchesName(candidate: SearchCandidate, name: string): boolean {
  if (candidate.name === name) return true;
  const qualifiedName = candidate.qualified_name;
  return qualifiedName === name || qualifiedName?.endsWith(`.${name}`) === true;
}

function filterCandidates(candidates: SearchCandidate[], params: Record<string, unknown>): SearchCandidate[] {
  let result = candidates;

  const qualifiedName = typeof params.qualified_name === "string" && params.qualified_name.trim() ? params.qualified_name.trim() : undefined;
  if (qualifiedName) {
    result = result.filter((candidate) => candidate.qualified_name === qualifiedName || candidate.qualified_name?.endsWith(`.${qualifiedName}`));
  }

  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
  if (name) {
    const exact = result.filter((candidate) => candidateMatchesName(candidate, name));
    if (exact.length > 0) result = exact;
  }

  const label = typeof params.label === "string" && params.label.trim() ? params.label.trim() : undefined;
  if (label) result = result.filter((candidate) => candidate.label === label || (label === "Route" && candidate.route_path));

  const filePath = typeof params.file_path === "string" && params.file_path.trim() ? normalizeForMatch(params.file_path.trim()) : undefined;
  if (filePath) {
    result = result.filter((candidate) => {
      const candidatePath = candidateFilePath(candidate);
      if (!candidatePath) return false;
      const normalized = normalizeForMatch(candidatePath);
      return normalized === filePath || normalized.endsWith(filePath) || normalized.includes(filePath);
    });
  }

  const parentClass = typeof params.parent_class === "string" && params.parent_class.trim() ? params.parent_class.trim() : undefined;
  if (parentClass) {
    result = result.filter((candidate) => candidate.parent_class === parentClass || candidate.qualified_name?.includes(`.${parentClass}.`) === true);
  }

  const routePath = typeof params.route_path === "string" && params.route_path.trim() ? params.route_path.trim() : undefined;
  if (routePath) result = result.filter((candidate) => candidate.route_path === routePath || stringProp(candidate, "path_pattern") === routePath);

  const routeMethod = typeof params.route_method === "string" && params.route_method.trim() ? params.route_method.trim().toUpperCase() : undefined;
  if (routeMethod) result = result.filter((candidate) => candidateRouteMethod(candidate)?.toUpperCase() === routeMethod);

  return result;
}

function compactResolveCandidate(candidate: SearchCandidate, includeMetadata: boolean): Record<string, unknown> {
  if (includeMetadata) return candidate;
  return removeUndefined({
    name: candidate.name,
    qualified_name: candidate.qualified_name,
    label: candidate.label,
    file_path: candidateFilePath(candidate),
    start_line: numberProp(candidate, "start_line"),
    end_line: numberProp(candidate, "end_line"),
    parent_class: candidate.parent_class,
    signature: candidate.signature,
    return_type: candidate.return_type,
    route_path: candidate.route_path,
    route_method: candidateRouteMethod(candidate),
  });
}

function symbolQuery(params: Record<string, unknown>): Record<string, unknown> {
  return removeUndefined({
    name: params.name,
    qualified_name: params.qualified_name,
    file_path: params.file_path,
    parent_class: params.parent_class,
    label: params.label,
    route_path: params.route_path,
    route_method: params.route_method,
  });
}

type SymbolResolution = {
  project: string;
  query: Record<string, unknown>;
  candidates: SearchCandidate[];
  consideredCandidates: number;
  stderr: string;
};

type LocationCache = Map<string, Promise<Partial<SearchCandidate>>>;

function hasLocation(candidate: SearchCandidate): boolean {
  return typeof candidateFilePath(candidate) === "string" && numberProp(candidate, "start_line") !== undefined && numberProp(candidate, "end_line") !== undefined;
}

async function fetchSymbolLocation(
  qualifiedName: string,
  project: string,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
  cache: LocationCache,
): Promise<Partial<SearchCandidate>> {
  const cached = cache.get(qualifiedName);
  if (cached) return cached;

  const request = (async () => {
    const result = await callCbmTool(
      "get_code_snippet",
      { project, qualified_name: qualifiedName },
      { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms), allowError: true },
    );
    if (!result.ok || !isRecord(result.data)) return {};
    return removeUndefined({
      name: result.data.name,
      qualified_name: result.data.qualified_name,
      label: result.data.label,
      file_path: result.data.file_path ?? result.data.file ?? result.data.path,
      start_line: numberProp(result.data, "start_line"),
      end_line: numberProp(result.data, "end_line"),
      parent_class: result.data.parent_class,
      signature: result.data.signature,
      return_type: result.data.return_type,
      route_path: result.data.route_path,
      route_method: result.data.route_method,
    }) as Partial<SearchCandidate>;
  })();

  cache.set(qualifiedName, request);
  return request;
}

async function enrichCandidatesWithLocations(
  candidates: SearchCandidate[],
  project: string,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
  cache: LocationCache = new Map(),
): Promise<SearchCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      if (hasLocation(candidate) || !candidate.qualified_name) return candidate;
      const location = await fetchSymbolLocation(candidate.qualified_name, project, ctx, params, cache);
      return { ...candidate, ...removeUndefined(location as Record<string, unknown>) };
    }),
  );
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

type MetadataProjection = {
  data: unknown;
  pruned: boolean;
};

function firstDocLine(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line;
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function compactSymbolLike(item: unknown, options: { includeSource?: boolean; includeMatches?: boolean } = {}): unknown {
  if (!isRecord(item)) return item;
  const compact = pickDefined(item, [
    "name",
    "qualified_name",
    "label",
    "kind",
    "type",
    "file_path",
    "file",
    "path",
    "start_line",
    "end_line",
    "line",
    "parent_class",
    "signature",
    "return_type",
    "route_method",
    "route_path",
    "http_method",
    "method",
    "path_pattern",
    "hop",
    "relationship",
    "edge_type",
    "risk",
  ]);

  const doc = firstDocLine(item.docstring ?? item.summary ?? item.description);
  if (doc !== undefined) compact.summary = doc;

  if (options.includeMatches) {
    Object.assign(compact, pickDefined(item, ["match_lines", "total_matches", "match_count", "total_grep_matches", "dedup_ratio"]));
  }

  if (options.includeSource) {
    Object.assign(compact, pickDefined(item, ["source", "context", "code", "snippet", "source_code", "code_snippet", "raw_source"]));
  }

  return compact;
}

function compactSymbolArray(value: unknown, options: { includeSource?: boolean; includeMatches?: boolean } = {}): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => compactSymbolLike(item, options));
}

function compactTraceItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const compact = compactSymbolLike(item);
  if (!isRecord(compact)) return compact;
  Object.assign(compact, pickDefined(item, ["from", "to", "target", "operation", "duration_ms", "latency_ms", "count"]));

  const source = item.source;
  if (typeof source === "string" && !source.includes("\n")) compact.source = source;

  return compact;
}

function compactTraceArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(compactTraceItem);
}

function appendMetadataHint(data: unknown): unknown {
  const hint = "Compact result: less-useful graph metadata is hidden. Rerun with include_metadata=true for full upstream metrics/raw fields.";
  if (isRecord(data) && data._metadata_hint === undefined) return { ...data, _metadata_hint: hint };
  return data;
}

function compactSearchGraphData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["project", "query", "label", "total", "has_more", "limit", "offset"]);
  if (Array.isArray(data.results)) compact.results = compactSymbolArray(data.results);
  if (Array.isArray(data.semantic_results)) compact.semantic_results = compactSymbolArray(data.semantic_results);
  if (Array.isArray(data.connected)) compact.connected = compactSymbolArray(data.connected);
  if (Array.isArray(data.candidates)) compact.candidates = compactSymbolArray(data.candidates);
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactCodeSnippetData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = compactSymbolLike(data, { includeSource: true });
  if (!isRecord(compact)) return { data, pruned: false };
  Object.assign(compact, pickDefined(data, ["callers", "callees", "caller_names", "callee_names", "route_method", "route_path"]));
  if (Array.isArray(data.callers)) compact.callers = compactSymbolArray(data.callers);
  if (Array.isArray(data.callees)) compact.callees = compactSymbolArray(data.callees);
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactReadSymbolData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  if (data.ambiguous || data.error) return { data, pruned: false };
  const snippet = compactCodeSnippetData(data);
  if (!isRecord(snippet.data)) return snippet;
  return { data: { resolved: data.resolved, ...snippet.data }, pruned: snippet.pruned };
}

function compactTraceDataForOutput(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["function", "resolved_function", "direction", "mode", "parameter_name", "depth"]);
  for (const key of ["callers", "callees", "paths", "nodes", "edges", "data_flow", "cross_service_paths"]) {
    const value = data[key];
    compact[key] = Array.isArray(value) ? compactTraceArray(value) : value;
  }
  return { data: appendMetadataHint(removeUndefined(compact)), pruned: true };
}

function compactSearchCodeData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["pattern", "total_grep_matches", "total_results", "dedup_ratio", "has_more", "limit", "offset"]);
  if (Array.isArray(data.results)) compact.results = compactSymbolArray(data.results, { includeSource: true, includeMatches: true });
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactArchitectureEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return pickDefined(value, [
    "name",
    "qualified_name",
    "label",
    "kind",
    "file_path",
    "file",
    "path",
    "start_line",
    "end_line",
    "route_method",
    "route_path",
    "fan_in",
    "fan_out",
    "call_count",
    "from",
    "to",
    "layer",
    "reason",
    "language",
    "count",
  ]);
}

function compactArchitectureData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, [
    "project",
    "total_nodes",
    "total_edges",
    "languages",
    "packages",
    "modules",
    "entry_points",
    "hotspots",
    "routes",
    "boundaries",
    "layers",
    "dependencies",
  ]);

  for (const [key, value] of Object.entries(compact)) {
    if (Array.isArray(value)) compact[key] = value.map(compactArchitectureEntry);
  }

  return { data: appendMetadataHint(compact), pruned: true };
}

function compactDetectChangesData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["changed_files", "changed_count", "depth", "risk", "summary"]);
  if (Array.isArray(data.impacted_symbols)) compact.impacted_symbols = compactSymbolArray(data.impacted_symbols);
  if (Array.isArray(data.impacts)) compact.impacts = compactSymbolArray(data.impacts);
  return { data: appendMetadataHint(compact), pruned: true };
}

function projectMetadata(toolName: string, data: unknown, controls: OutputControls): MetadataProjection {
  if (controls.includeMetadata) return { data, pruned: false };

  switch (toolName) {
    case "search_graph":
      return compactSearchGraphData(data);
    case "get_code_snippet":
      return compactCodeSnippetData(data);
    case "read_symbol":
      return compactReadSymbolData(data);
    case "trace_path":
      return compactTraceDataForOutput(data);
    case "search_code":
      return compactSearchCodeData(data);
    case "get_architecture":
      return compactArchitectureData(data);
    case "detect_changes":
      return compactDetectChangesData(data);
    default:
      return { data, pruned: false };
  }
}

async function buildCompactableToolResult(
  title: string,
  data: unknown,
  params: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  const controls = outputControls(params);
  const toolName = typeof details.tool === "string" ? details.tool : "";
  const projected = projectMetadata(toolName, data, controls);
  const compaction = compactSymbolBlocks(projected.data, controls);
  const resultDetails: Record<string, unknown> = {
    ...details,
    full_output: controls.fullOutput,
    include_metadata: controls.includeMetadata,
    max_symbol_lines: controls.maxSymbolLines,
  };

  if (projected.pruned) {
    resultDetails.metadataPruned = true;
    resultDetails.metadataHint = "Rerun with include_metadata=true for full upstream graph metrics/raw fields.";
  }

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

async function resolveSymbolCandidates(params: Record<string, unknown>, ctx: ExtensionContext): Promise<SymbolResolution> {
  const args = await withProject(stripOutputControls(params), ctx);
  const project = String(args.project ?? "");
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const qualifiedName = typeof args.qualified_name === "string" ? args.qualified_name.trim() : "";
  const limit = clampInt(args.limit, 20, 1, 100);
  const searches: Record<string, unknown>[] = [];

  if (qualifiedName) searches.push({ qn_pattern: `.*${escapeRegExp(qualifiedName)}.*` });
  if (name) {
    searches.push({ name_pattern: `^${escapeRegExp(name)}$` });
    searches.push({ qn_pattern: `.*${escapeRegExp(name)}.*` });
    searches.push({ query: name });
  }

  if (searches.length === 0) throw new Error("resolve_symbol/read_symbol requires name or qualified_name.");

  const candidates: SearchCandidate[] = [];
  let stderr = "";
  for (const search of searches) {
    const result = await callCbmTool(
      "search_graph",
      removeUndefined({ project, limit: Math.max(limit, 20), ...search }),
      { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms), allowError: true },
    );
    stderr += result.stderr;
    if (!result.ok) continue;
    candidates.push(...allSearchCandidates(result.data));
  }

  const deduped = dedupeCandidates(candidates);
  const filtered = filterCandidates(deduped, args).slice(0, limit);
  return {
    project,
    query: symbolQuery(args),
    candidates: await enrichCandidatesWithLocations(filtered, project, ctx, params),
    consideredCandidates: deduped.length,
    stderr,
  };
}

function renderSymbolResolution(resolution: SymbolResolution, params: Record<string, unknown>): Record<string, unknown> {
  const includeMetadata = params.include_metadata === true;
  const candidates = resolution.candidates.map((candidate) => compactResolveCandidate(candidate, includeMetadata));

  if (candidates.length === 0) {
    return {
      error: "symbol not found",
      query: resolution.query,
      total_candidates: 0,
      considered_candidates: resolution.consideredCandidates,
      hint: "Try search_graph with a broader query or fewer disambiguators.",
    };
  }

  return {
    query: resolution.query,
    total_candidates: candidates.length,
    considered_candidates: resolution.consideredCandidates,
    ambiguous: candidates.length !== 1,
    hint: candidates.length === 1 ? undefined : "Multiple matching symbols found. Retry with file_path, parent_class, label, route_path, route_method, or qualified_name.",
    candidates,
  };
}

function requestedNeighbors(params: Record<string, unknown>): "none" | "callers" | "callees" | "both" {
  if (params.include_neighbors === true) return "both";
  if (params.neighbors === "callers" || params.neighbors === "callees" || params.neighbors === "both") return params.neighbors;
  return "none";
}

function neighborDirection(neighbors: "none" | "callers" | "callees" | "both"): "inbound" | "outbound" | "both" | undefined {
  if (neighbors === "callers") return "inbound";
  if (neighbors === "callees") return "outbound";
  if (neighbors === "both") return "both";
  return undefined;
}

async function directNeighbors(
  data: unknown,
  key: "callers" | "callees",
  limit: number,
  includeMetadata: boolean,
  project: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  cache: LocationCache,
): Promise<Record<string, unknown>[] | undefined> {
  if (!isRecord(data) || !Array.isArray(data[key])) return undefined;
  const candidates = data[key].slice(0, limit).map((item) => {
    if (!isRecord(item)) return { name: String(item) };
    return item as SearchCandidate;
  });
  const enriched = await enrichCandidatesWithLocations(candidates, project, ctx, params, cache);
  return enriched.map((candidate) => compactResolveCandidate(candidate, includeMetadata));
}

async function symbolNeighbors(
  qualifiedName: string,
  project: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<{ data: Record<string, unknown>; stderr: string }> {
  const neighbors = requestedNeighbors(params);
  const direction = neighborDirection(neighbors);
  if (!direction) return { data: {}, stderr: "" };

  const limit = clampInt(params.neighbor_limit, 10, 1, 50);
  const trace = await callCbmTool(
    "trace_path",
    { project, function_name: qualifiedName, direction, mode: "calls", depth: 1, risk_labels: false },
    { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms), allowError: true },
  );

  if (!trace.ok) {
    return {
      data: {
        neighbors_error: errorText(trace.data),
        neighbors_hint: "Direct neighbor lookup failed; use trace_path for explicit caller/callee tracing.",
      },
      stderr: trace.stderr,
    };
  }

  const includeMetadata = params.include_metadata === true;
  const cache: LocationCache = new Map();
  const callers = neighbors === "callers" || neighbors === "both" ? await directNeighbors(trace.data, "callers", limit, includeMetadata, project, params, ctx, cache) : undefined;
  const callees = neighbors === "callees" || neighbors === "both" ? await directNeighbors(trace.data, "callees", limit, includeMetadata, project, params, ctx, cache) : undefined;

  return {
    data: removeUndefined({
      neighbors,
      neighbor_limit: limit,
      callers,
      callees,
      caller_count: callers?.length,
      callee_count: callees?.length,
      neighbors_hint: "Neighbors are direct-only, compact, and source-free. Use trace_path for multi-hop workflow or impact tracing.",
    }),
    stderr: trace.stderr,
  };
}

async function enrichTraceLocations(data: unknown, project: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
  const cache: LocationCache = new Map();
  let remaining = 50;

  const visit = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!isRecord(value)) return value;

    let clone: Record<string, unknown> = { ...value };
    const qualifiedName = stringProp(clone, "qualified_name");
    if (qualifiedName && remaining > 0 && !hasLocation(clone as SearchCandidate)) {
      remaining -= 1;
      const location = await fetchSymbolLocation(qualifiedName, project, ctx, params, cache);
      clone = { ...clone, ...removeUndefined(location as Record<string, unknown>) };
    }

    const entries = await Promise.all(Object.entries(clone).map(async ([key, entry]) => [key, await visit(entry)] as const));
    return Object.fromEntries(entries);
  };

  return visit(data);
}

async function executeResolveSymbol(params: Record<string, unknown>, ctx: ExtensionContext) {
  const resolution = await resolveSymbolCandidates(params, ctx);
  return buildCompactableToolResult("Symbol resolution", renderSymbolResolution(resolution, params), params, {
    tool: "resolve_symbol",
    args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
    stderr: resolution.stderr,
  });
}

async function executeReadSymbol(params: Record<string, unknown>, ctx: ExtensionContext) {
  const resolution = await resolveSymbolCandidates(params, ctx);
  const rendered = renderSymbolResolution(resolution, params);

  if (resolution.candidates.length !== 1) {
    return buildCompactableToolResult("Symbol source", rendered, params, {
      tool: "read_symbol",
      args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
      stderr: resolution.stderr,
    });
  }

  const candidate = resolution.candidates[0]!;
  const snippetArgs = removeUndefined({
    project: resolution.project,
    qualified_name: candidate.qualified_name,
  });
  const snippet = await callCbmTool("get_code_snippet", snippetArgs, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
  const neighbors = await symbolNeighbors(String(candidate.qualified_name), resolution.project, params, ctx);
  const resolved = compactResolveCandidate(candidate, params.include_metadata === true);
  const data = isRecord(snippet.data) ? { resolved, ...snippet.data, ...neighbors.data } : { resolved, snippet: snippet.data, ...neighbors.data };

  return buildCompactableToolResult("Symbol source", data, params, {
    tool: "read_symbol",
    args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
    snippet_args: snippetArgs,
    stderr: `${resolution.stderr}${snippet.stderr}${neighbors.stderr}`,
  });
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
    const enriched = await enrichTraceLocations(filterTraceData(result.data, params), project, params, ctx);
    return buildCompactableToolResult("Trace path results", enriched, params, { tool: "trace_path", args, stderr: result.stderr });
  }
  if (!isFunctionNotFound(result.data) || !functionName || !project) throw new Error(errorText(result.data));

  const candidates = await findTraceCandidates(functionName, project, ctx);
  if (candidates.length === 1 && candidates[0]?.qualified_name) {
    const resolvedArgs = { ...args, function_name: candidates[0].qualified_name };
    const resolved = await callCbmTool("trace_path", resolvedArgs, {
      signal: ctx.signal,
      timeoutMs: queryTimeoutMs(params.timeout_ms),
    });
    const enriched = await enrichTraceLocations(filterTraceData(resolved.data, params), project, params, ctx);
    return buildCompactableToolResult("Trace path results", enriched, params, {
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
    name: "search_graph",
    label: "CBM Search Graph",
    description: "Search the code graph for symbols and implementation locations: functions, methods, classes, routes, controllers, services, and related concepts.",
    promptSnippet: "search_graph(query/name_pattern/semantic_query, project?): structural and semantic code graph search",
    promptGuidelines: [
      "Use search_graph first for symbol/workflow/route/class/function discovery and 'where is X implemented/handled/performed?' questions.",
      "Use a small limit, usually 5-12, for targeted location lookup.",
      "Use search_graph before read_symbol/get_code_snippet to discover likely target symbols for conceptual queries.",
      "Do not use search_graph for exact literal strings, manifests, README/config inspection, or reading known files; use search_code or file reads instead.",
      "Results are compact and location-first by default to save context; set include_metadata=true only when raw graph metrics/fingerprints are needed.",
      "If returned code/source context is compacted, retry with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
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
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
      return executeQueryTool("Graph search results", "search_graph", { limit: 25, ...params }, ctx);
    },
    renderCall: renderCall("search_graph", (args) => String(args.query ?? args.name_pattern ?? args.semantic_query ?? "")),
    renderResult: renderResult("search_graph"),
  });

  pi.registerTool({
    name: "resolve_symbol",
    label: "CBM Resolve Symbol",
    description: "Resolve a symbol name to compact candidate identities without returning source.",
    promptSnippet: "resolve_symbol(name, file_path?/parent_class?/label?): resolve symbol candidates without source",
    promptGuidelines: [
      "Use resolve_symbol when you know a symbol name but need the exact qualified_name or need to disambiguate candidates.",
      "Add file_path, parent_class, label, route_path, or route_method to narrow ambiguous names.",
      "resolve_symbol does not return source; use read_symbol when you want source only if the match is unambiguous.",
      "Results are compact by default; set include_metadata=true only when raw candidate metadata is needed.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name or qualified-name suffix to resolve." }),
      project: OPTIONAL_PROJECT,
      qualified_name: Type.Optional(Type.String({ description: "Exact or suffix qualified_name disambiguator." })),
      file_path: Type.Optional(Type.String({ description: "File path substring or suffix disambiguator." })),
      parent_class: Type.Optional(Type.String({ description: "Parent class name disambiguator for methods/classes." })),
      label: Type.Optional(SYMBOL_LABEL),
      route_path: Type.Optional(Type.String({ description: "Route path disambiguator, when indexed." })),
      route_method: Type.Optional(Type.String({ description: "Route HTTP method disambiguator, when indexed." })),
      limit: Type.Optional(Type.Number({ default: 20 })),
      ...METADATA_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeResolveSymbol(params, ctx);
    },
    renderCall: renderCall("resolve_symbol", (args) => String(args.name ?? args.qualified_name ?? "")),
    renderResult: renderResult("resolve_symbol"),
  });

  pi.registerTool({
    name: "read_symbol",
    label: "CBM Read Symbol",
    description: "Resolve a symbol name and read its source only when the match is unambiguous.",
    promptSnippet: "read_symbol(name, file_path?/parent_class?/label?): read source only if symbol resolution is unambiguous",
    promptGuidelines: [
      "Use read_symbol when you know a symbol name plus enough disambiguators, such as file_path, parent_class, label, route_path, or route_method.",
      "read_symbol fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use get_code_snippet with an exact qualified_name.",
      "Prefer read_symbol/get_code_snippet over raw file reads when the target is a symbol; prefer file reads for known files, configs, docs, manifests, or non-symbol content.",
      "Use neighbors='callers'/'callees'/'both' only when direct surrounding call context is useful; neighbors are direct-only, compact, source-free, and limited by neighbor_limit.",
      "Use trace_path instead of read_symbol neighbors for multi-hop workflow, dependency, impact, data-flow, or cross-service tracing.",
      "read_symbol has the same source-output controls as get_code_snippet: increase max_symbol_lines or set full_output=true if source is compacted.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name or qualified-name suffix to resolve and read." }),
      project: OPTIONAL_PROJECT,
      qualified_name: Type.Optional(Type.String({ description: "Exact or suffix qualified_name disambiguator." })),
      file_path: Type.Optional(Type.String({ description: "File path substring or suffix disambiguator." })),
      parent_class: Type.Optional(Type.String({ description: "Parent class name disambiguator for methods/classes." })),
      label: Type.Optional(SYMBOL_LABEL),
      route_path: Type.Optional(Type.String({ description: "Route path disambiguator, when indexed." })),
      route_method: Type.Optional(Type.String({ description: "Route HTTP method disambiguator, when indexed." })),
      neighbors: Type.Optional(SYMBOL_NEIGHBORS),
      neighbor_limit: Type.Optional(Type.Number({ default: 10, description: "Maximum direct callers/callees to return per side when neighbors is enabled. Default 10." })),
      include_neighbors: Type.Optional(Type.Boolean({ description: "Compatibility alias for neighbors='both'." })),
      limit: Type.Optional(Type.Number({ default: 20 })),
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeReadSymbol(params, ctx);
    },
    renderCall: renderCall("read_symbol", (args) => String(args.name ?? args.qualified_name ?? "")),
    renderResult: renderResult("read_symbol"),
  });

  pi.registerTool({
    name: "get_code_snippet",
    label: "CBM Snippet",
    description: "Retrieve compact source for a known graph symbol by qualified_name.",
    promptSnippet: "get_code_snippet(qualified_name, project?): read precise source for a graph symbol",
    promptGuidelines: [
      "Use get_code_snippet only after search_graph/search_code identifies the qualified_name; it is a retrieval tool, not a search tool.",
      "Prefer read_symbol when you know a concrete symbol name plus disambiguators but do not have the exact qualified_name.",
      "Keep snippets targeted. Retrieve one or two likely symbols first instead of bulk-reading many symbols.",
      "Do not use get_code_snippet for broad file inspection, docs/config/manifests, or known file paths; read the file directly when that is the actual task.",
      "By default, get_code_snippet returns source plus minimal location/call metadata; set include_metadata=true for full metrics/raw fields.",
      "If an oversized symbol is compacted, retry get_code_snippet with a higher max_symbol_lines or full_output=true before using read.",
    ],
    parameters: Type.Object({
      qualified_name: Type.String({ description: "Full qualified_name from search_graph, or a short name if unambiguous." }),
      project: OPTIONAL_PROJECT,
      include_neighbors: Type.Optional(Type.Boolean()),
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
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
    description: "Trace callers, callees, data flow, or cross-service paths from a known anchor function/method.",
    promptSnippet: "trace_path(function_name, direction?, mode?): trace callers, callees, data-flow, or cross-service paths",
    promptGuidelines: [
      "Use trace_path for caller/callee questions, dependency tracing, workflow tracing, data-flow tracing, and impact analysis instead of repeated grep.",
      "Use trace_path after selecting an anchor symbol with search_graph unless the exact function_name is already known.",
      "Keep depth shallow by default, usually 2-3; deeper traces can be noisy and context-heavy.",
      "Short names are auto-resolved when unambiguous; if multiple candidates are returned, retry with an exact qualified_name.",
      "Trace output may include local helper functions; use exclude_paths or a more specific anchor if they are not relevant.",
      "Trace output is compact by default; set include_metadata=true only when raw trace/graph metadata is needed.",
      "If returned code/source context is compacted, retry with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
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
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
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
    description: "Get a compact high-level architecture overview: hotspots, routes/entry points, packages, dependencies, and layers when available.",
    promptSnippet: "get_architecture(project?, aspects?): high-level codebase architecture overview",
    promptGuidelines: [
      "Use get_architecture early when orienting yourself in an indexed codebase.",
      "Do not use get_architecture for targeted 'where is X implemented?' lookup; use search_graph instead.",
      "Architecture output is compact by default and prioritizes entry points, hotspots, boundaries, layers, routes, packages, and dependencies; set include_metadata=true for the full upstream overview.",
      "Requested aspects may be absent when the index has no data for them; use search_graph or query_graph for targeted route/entry-point lookup.",
      "For large repos, prefer targeted aspects such as entry_points, hotspots, dependencies, or layers instead of requesting everything.",
      "If returned code/source context is compacted, retry with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
    ],
    parameters: Type.Object({ project: OPTIONAL_PROJECT, aspects: Type.Optional(Type.Array(Type.String())), ...EXPLORATION_OUTPUT_CONTROL_PARAMS, timeout_ms: TIMEOUT_MS }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Architecture overview", "get_architecture", params, ctx);
    },
    renderCall: renderCall("get_architecture"),
    renderResult: renderResult("get_architecture"),
  });

  pi.registerTool({
    name: "get_graph_schema",
    label: "CBM Schema",
    description: "Inspect available graph labels, edge types, and properties.",
    promptSnippet: "get_graph_schema(project?): inspect available graph labels, edge types, and properties",
    promptGuidelines: [
      "Use get_graph_schema before writing non-trivial query_graph Cypher.",
      "Use sparingly; it is schema metadata and may be verbose. Do not use it for normal symbol lookup.",
    ],
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
    description: "Run read-only Cypher-like graph queries for custom structural questions, aggregations, and multi-hop relationships.",
    promptSnippet: "query_graph(query, project?): run read-only Cypher over the code graph",
    promptGuidelines: [
      "Use query_graph for complex multi-hop graph questions after checking get_graph_schema. Prefer search_graph for simple symbol discovery.",
      "Keep returned columns narrow and limit row counts to control context.",
      "codebase-memory query_graph supports a Cypher-like subset, not necessarily full Neo4j Cypher; prefer simple MATCH patterns.",
      "If returned code/source cells are compacted, retry with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
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
    description: "Literal text/regex search over indexed files, enriched with symbol-grouped context.",
    promptSnippet: "search_code(pattern, project?): grep-like search enriched with graph context",
    promptGuidelines: [
      "Use search_code for exact literal text/regex search in indexed files: env vars, config keys, route strings, error messages, constants, template text, comments, and docstrings.",
      "If the query is a symbol name, prefer resolve_symbol/read_symbol; use search_code when you need all textual occurrences or exact non-symbol text.",
      "Prefer search_graph for conceptual/symbol discovery and trace_path for call relationships.",
      "search_code returns compact symbol-grouped matches by default; set include_metadata=true only when raw enrichment metadata is needed.",
      "Oversized per-symbol contexts are compacted by default; retry search_code with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
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
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Code search results", "search_code", { mode: "compact", context: 2, limit: 10, ...params }, ctx);
    },
    renderCall: renderCall("search_code", (args) => String(args.pattern ?? "")),
    renderResult: renderResult("search_code"),
  });

  pi.registerTool({
    name: "detect_changes",
    label: "CBM Detect Changes",
    description: "Analyze local git changes and map them to affected symbols/callers.",
    promptSnippet: "detect_changes(project?, depth?, base_branch?/since?): graph impact analysis for local changes",
    promptGuidelines: [
      "Use detect_changes when reviewing local diffs or estimating blast radius before editing or committing.",
      "Do not use detect_changes for ordinary lookup tasks or when there are no relevant local changes.",
      "Change impact output is compact by default; set include_metadata=true for full raw impact metadata.",
      "If returned code/source context is compacted, retry with a higher max_symbol_lines or full_output=true before falling back to read/grep.",
    ],
    parameters: Type.Object({
      project: OPTIONAL_PROJECT,
      scope: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Number({ default: 2 })),
      base_branch: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      ...EXPLORATION_OUTPUT_CONTROL_PARAMS,
      timeout_ms: TIMEOUT_MS,
    }),
    async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      return executeQueryTool("Change impact results", "detect_changes", params, ctx);
    },
    renderCall: renderCall("detect_changes"),
    renderResult: renderResult("detect_changes"),
  });

}
