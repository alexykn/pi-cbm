import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildToolTextResult, callCbmTool, queryTimeoutMs, removeUndefined } from "./cbm.js";
import { buildCompactableToolResult, stripOutputControls } from "./tool-output.js";
import { inferProject } from "./project.js";

export const DIRECTION = StringEnum(["inbound", "outbound", "both"] as const);
export const TRACE_MODE = StringEnum(["calls", "data_flow", "cross_service"] as const);
export const SEARCH_CODE_MODE = StringEnum(["compact", "full", "files"] as const);
export const SYMBOL_LABEL = StringEnum(["Function", "Method", "Class", "Variable", "Type", "Route"] as const);
export const SYMBOL_NEIGHBORS = StringEnum(["none", "callers", "callees", "both"] as const);

export const OPTIONAL_PROJECT = Type.Optional(Type.String({ description: "Indexed project name. If omitted, inferred from the current working directory." }));
export const TIMEOUT_MS = Type.Optional(Type.Number({ description: "Timeout in milliseconds for this codebase-memory-mcp CLI call." }));
export const FULL_OUTPUT = Type.Optional(
  Type.Boolean({
    description:
      "Return complete per-symbol code/source blocks. Use this if a prior result was compacted and the full function/class is needed. Default false; global safety truncation may still apply.",
  }),
);
export const INCLUDE_METADATA = Type.Optional(
  Type.Boolean({
    description:
      "Include full upstream graph metrics, fingerprints, token fields, and raw metadata. Default false keeps output compact and location-first for context-efficient exploration.",
  }),
);
export const MAX_SYMBOL_LINES = Type.Optional(
  Type.Number({
    default: 220,
    description:
      "Maximum lines to include per returned function, method, class, or symbol-sized code block before compacting. Default 220. Ignored when full_output=true.",
  }),
);
export const OUTPUT_CONTROL_PARAMS = { full_output: FULL_OUTPUT, max_symbol_lines: MAX_SYMBOL_LINES };
export const EXPLORATION_OUTPUT_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA, ...OUTPUT_CONTROL_PARAMS };
export const METADATA_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA };

async function withProject<T extends Record<string, unknown>>(params: T, ctx: ExtensionContext): Promise<Record<string, unknown>> {
  if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
  return removeUndefined({ ...params, project: await inferProject(ctx.cwd, ctx.signal) });
}

export async function executeQueryTool(
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

export async function executeResolveSymbol(params: Record<string, unknown>, ctx: ExtensionContext) {
  const resolution = await resolveSymbolCandidates(params, ctx);
  return buildCompactableToolResult("Symbol resolution", renderSymbolResolution(resolution, params), params, {
    tool: "resolve_symbol",
    args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
    stderr: resolution.stderr,
  });
}

export async function executeReadSymbol(params: Record<string, unknown>, ctx: ExtensionContext) {
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

export async function executeTracePath(params: Record<string, unknown>, ctx: ExtensionContext) {
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

export async function executeQueryGraph(params: Record<string, unknown>, ctx: ExtensionContext) {
  const args = await withProject(stripOutputControls({ max_rows: 200, ...params }), ctx);
  const result = await callCbmTool("query_graph", args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
  return buildCompactableToolResult("Cypher query results", coerceQueryGraphMetrics(result.data), params, {
    tool: "query_graph",
    args,
    stderr: result.stderr,
    numeric_metrics_normalized: true,
  });
}

export function renderCall(label: string, pick: (args: Record<string, unknown>) => string | undefined = () => undefined) {
  return (args: Record<string, unknown>, theme: any) => {
    const suffix = pick(args);
    return new Text(`${theme.fg("toolTitle", theme.bold(`${label} `))}${suffix ? theme.fg("accent", suffix) : ""}`, 0, 0);
  };
}

export function renderResult(label: string) {
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

