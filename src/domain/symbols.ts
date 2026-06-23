import { CbmClient } from "../cbm/client.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { mapLimit } from "../shared/concurrency.js";
import { clampInt } from "../shared/numbers.js";
import { isRecord, numberProp, removeUndefined, stringProp } from "../shared/object.js";
import { errorText, escapeRegExp, normalizeForMatch } from "../shared/strings.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type ToolExecutionContext } from "./project.js";

const MAX_BATCH_SNIPPETS = 50;
const MAX_BATCH_SYMBOLS = 30;
const MAX_SEARCH_AND_READ = 20;
const MAX_SEARCH_LIMIT = 50;

type BatchCallResult = { data: Record<string, unknown>; stderr: string };

export type SearchCandidate = {
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

type SymbolResolution = {
  project: string;
  query: Record<string, unknown>;
  candidates: SearchCandidate[];
  consideredCandidates: number;
  stderr: string;
};

type LocationCache = Map<string, Promise<Partial<SearchCandidate>>>;

export function searchCandidates(data: unknown): SearchCandidate[] {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter((item): item is SearchCandidate => {
    if (!isRecord(item) || typeof item.qualified_name !== "string") return false;
    return item.label === "Function" || item.label === "Method" || item.label === undefined;
  });
}

export function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
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

function candidateFilePath(candidate: SearchCandidate): string | undefined {
  return stringProp(candidate, "file_path") ?? stringProp(candidate, "file") ?? stringProp(candidate, "path");
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

export function compactResolveCandidate(candidate: SearchCandidate, includeMetadata: boolean): Record<string, unknown> {
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

function symbolRequest(params: Record<string, unknown>): Record<string, unknown> {
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

function batchConcurrency(value: unknown, fallback: number, max: number): number {
  return clampInt(value, fallback, 1, max);
}

function statusCounts(results: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const status = typeof result.status === "string" ? result.status : "unknown";
    counts[`${status}_count`] = (counts[`${status}_count`] ?? 0) + 1;
  }
  return counts;
}

function stringsArrayParam(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (items.length === 0) throw new Error(`${name} must include at least one non-empty string.`);
  if (items.length > max) throw new Error(`${name} supports at most ${max} entries per call.`);
  return items;
}

function symbolRequestsParam(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("symbols must be an array of symbol request objects.");
  if (value.length === 0) throw new Error("symbols must include at least one request.");
  if (value.length > MAX_BATCH_SYMBOLS) throw new Error(`symbols supports at most ${MAX_BATCH_SYMBOLS} entries per call.`);

  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`symbols[${index}] must be an object.`);
    const request = symbolRequest(item);
    if (typeof request.name !== "string" && typeof request.qualified_name !== "string") {
      throw new Error(`symbols[${index}] must include name or qualified_name.`);
    }
    return request;
  });
}

function hasSearchInput(params: Record<string, unknown>): boolean {
  return [params.query, params.name_pattern, params.qn_pattern, params.file_pattern].some((value) => typeof value === "string" && value.trim()) ||
    (Array.isArray(params.semantic_query) && params.semantic_query.some((value) => typeof value === "string" && value.trim()));
}

export function hasLocation(candidate: SearchCandidate): boolean {
  return typeof candidateFilePath(candidate) === "string" && numberProp(candidate, "start_line") !== undefined && numberProp(candidate, "end_line") !== undefined;
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

export class SymbolService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly projects: ProjectService,
    private readonly output: OutputService,
  ) {}

  async fetchSymbolLocation(
    qualifiedName: string,
    project: string,
    ctx: ToolExecutionContext,
    params: Record<string, unknown>,
    cache: LocationCache,
  ): Promise<Partial<SearchCandidate>> {
    const cached = cache.get(qualifiedName);
    if (cached) return cached;

    const request = (async () => {
      const result = await this.cbm.callTool(
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

  async enrichCandidatesWithLocations(
    candidates: SearchCandidate[],
    project: string,
    ctx: ToolExecutionContext,
    params: Record<string, unknown>,
    cache: LocationCache = new Map(),
  ): Promise<SearchCandidate[]> {
    return Promise.all(
      candidates.map(async (candidate) => {
        if (hasLocation(candidate) || !candidate.qualified_name) return candidate;
        const location = await this.fetchSymbolLocation(candidate.qualified_name, project, ctx, params, cache);
        return { ...candidate, ...removeUndefined(location as Record<string, unknown>) };
      }),
    );
  }

  async resolveCandidates(params: Record<string, unknown>, ctx: ToolExecutionContext): Promise<SymbolResolution> {
    const args = await this.withProject(stripOutputControls(params), ctx);
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

    const results = await Promise.all(
      searches.map((search) =>
        this.cbm.callTool("search_graph", removeUndefined({ project, limit: Math.max(limit, 20), ...search }), {
          signal: ctx.signal,
          timeoutMs: queryTimeoutMs(params.timeout_ms),
          allowError: true,
        }),
      ),
    );

    const candidates = results.flatMap((result) => (result.ok ? allSearchCandidates(result.data) : []));
    const stderr = results.map((result) => result.stderr).join("");

    const deduped = dedupeCandidates(candidates);
    const filtered = filterCandidates(deduped, args).slice(0, limit);
    return {
      project,
      query: symbolQuery(args),
      candidates: await this.enrichCandidatesWithLocations(filtered, project, ctx, params),
      consideredCandidates: deduped.length,
      stderr,
    };
  }

  async resolve(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const resolution = await this.resolveCandidates(params, ctx);
    return this.output.buildCompactableToolResult("Symbol resolution", renderSymbolResolution(resolution, params), params, {
      tool: "resolve_symbol",
      args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
      stderr: resolution.stderr,
    });
  }

  async read(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const resolution = await this.resolveCandidates(params, ctx);
    const rendered = renderSymbolResolution(resolution, params);

    if (resolution.candidates.length !== 1) {
      return this.output.buildCompactableToolResult("Symbol source", rendered, params, {
        tool: "read_symbol",
        args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
        stderr: resolution.stderr,
      });
    }

    const candidate = resolution.candidates[0]!;
    const read = await this.readResolvedCandidate(candidate, resolution.project, params, ctx);
    const resolved = compactResolveCandidate(candidate, params.include_metadata === true);
    const data = isRecord(read.data) ? { resolved, ...read.data } : { resolved, snippet: read.data };

    return this.output.buildCompactableToolResult("Symbol source", data, params, {
      tool: "read_symbol",
      args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
      stderr: `${resolution.stderr}${read.stderr}`,
    });
  }

  async getSnippets(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const qualifiedNames = stringsArrayParam(params.qualified_names, "qualified_names", MAX_BATCH_SNIPPETS);
    const args = await this.withProject(stripOutputControls({ project: params.project }), ctx);
    const project = String(args.project ?? "");
    const concurrency = batchConcurrency(params.max_concurrency, 8, 16);

    const cache = new Map<string, Promise<BatchCallResult>>();
    const readQualifiedName = (qualifiedName: string) => {
      const cached = cache.get(qualifiedName);
      if (cached) return cached;
      const request = this.readQualifiedName(qualifiedName, project, params, ctx);
      cache.set(qualifiedName, request);
      return request;
    };

    const results = await mapLimit(qualifiedNames, concurrency, async (qualifiedName, index) => {
      try {
        const result = await readQualifiedName(qualifiedName);
        return { index, qualified_name: qualifiedName, status: "ok", snippet: result.data, stderr: result.stderr };
      } catch (error) {
        return { index, qualified_name: qualifiedName, status: "error", error: errorText(error), stderr: "" };
      }
    });

    const data = {
      project,
      requested_count: qualifiedNames.length,
      returned_count: results.filter((result) => result.status === "ok").length,
      failed_count: results.filter((result) => result.status === "error").length,
      max_concurrency: concurrency,
      results: results.map(({ stderr: _stderr, ...result }) => result),
    };

    return this.output.buildCompactableToolResult("Code snippets", data, params, {
      tool: "get_code_snippets",
      args: removeUndefined({ project, qualified_names: qualifiedNames, include_neighbors: params.include_neighbors }),
      stderr: results.map((result) => result.stderr).join(""),
    });
  }

  async readMany(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const requests = symbolRequestsParam(params.symbols);
    const args = await this.withProject(stripOutputControls({ project: params.project }), ctx);
    const project = String(args.project ?? "");
    const concurrency = batchConcurrency(params.max_concurrency, 4, 12);

    const results = await mapLimit(requests, concurrency, async (request, index) => {
      try {
        return await this.readOneSymbol(request, project, params, ctx, index);
      } catch (error) {
        return { index, request, status: "error", error: errorText(error), stderr: "" };
      }
    });

    const dataResults = results.map(({ stderr: _stderr, ...result }) => result);
    const data = {
      project,
      requested_count: requests.length,
      read_count: dataResults.filter((result) => result.status === "ok").length,
      max_concurrency: concurrency,
      ...statusCounts(dataResults),
      results: dataResults,
    };

    return this.output.buildCompactableToolResult("Symbol sources", data, params, {
      tool: "read_symbols",
      args: removeUndefined({ project, symbols: requests, neighbors: params.neighbors, neighbor_limit: params.neighbor_limit }),
      stderr: results.map((result) => result.stderr).join(""),
    });
  }

  async searchAndRead(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    if (!hasSearchInput(params)) throw new Error("search_and_read_symbols requires query, name_pattern, qn_pattern, file_pattern, or semantic_query.");

    const searchLimit = clampInt(params.search_limit ?? params.limit, 12, 1, MAX_SEARCH_LIMIT);
    const readLimit = clampInt(params.read_limit, Math.min(searchLimit, 8), 1, MAX_SEARCH_AND_READ);
    const concurrency = batchConcurrency(params.max_concurrency, 6, 16);
    const upstream = stripOutputControls({
      ...params,
      limit: searchLimit,
      search_limit: undefined,
      read_limit: undefined,
      max_concurrency: undefined,
      include_neighbors: undefined,
      neighbors: undefined,
      neighbor_limit: undefined,
      timeout_ms: undefined,
    });
    const args = await this.withProject(upstream, ctx);
    const project = String(args.project ?? "");

    const search = await this.cbm.callTool("search_graph", args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
    const candidates = dedupeCandidates(allSearchCandidates(search.data));
    const selected = candidates.slice(0, Math.min(readLimit, candidates.length));
    const includeMetadata = params.include_metadata === true;

    const reads = await mapLimit(selected, concurrency, async (candidate, index) => {
      try {
        const result = await this.readQualifiedName(String(candidate.qualified_name), project, params, ctx);
        return {
          rank: index,
          qualified_name: candidate.qualified_name,
          status: "ok",
          search_result: compactResolveCandidate(candidate, includeMetadata),
          snippet: result.data,
          stderr: result.stderr,
        };
      } catch (error) {
        return {
          rank: index,
          qualified_name: candidate.qualified_name,
          status: "error",
          search_result: compactResolveCandidate(candidate, includeMetadata),
          error: errorText(error),
          stderr: "",
        };
      }
    });

    const dataResults = reads.map(({ stderr: _stderr, ...result }) => result);
    const data = {
      project,
      search: {
        query: params.query,
        name_pattern: params.name_pattern,
        qn_pattern: params.qn_pattern,
        file_pattern: params.file_pattern,
        label: params.label,
        search_limit: searchLimit,
        read_limit: Math.min(readLimit, candidates.length),
        total_candidates: candidates.length,
      },
      max_concurrency: concurrency,
      read_count: dataResults.filter((result) => result.status === "ok").length,
      ...statusCounts(dataResults),
      results: dataResults,
      unread_candidates: candidates.slice(selected.length).map((candidate, index) => ({ rank: selected.length + index, ...compactResolveCandidate(candidate, includeMetadata) })),
    };

    return this.output.buildCompactableToolResult("Search and read results", data, params, {
      tool: "search_and_read_symbols",
      args,
      stderr: `${search.stderr}${reads.map((result) => result.stderr).join("")}`,
    });
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
    return removeUndefined({ ...params, project: await this.projects.inferProject(ctx.cwd, ctx.signal) });
  }

  private async readQualifiedName(
    qualifiedName: string,
    project: string,
    params: Record<string, unknown>,
    ctx: ToolExecutionContext,
    includeUpstreamNeighbors = true,
  ): Promise<BatchCallResult> {
    const snippetArgs = removeUndefined({ project, qualified_name: qualifiedName, include_neighbors: includeUpstreamNeighbors ? params.include_neighbors : undefined });
    const snippet = await this.cbm.callTool("get_code_snippet", snippetArgs, {
      signal: ctx.signal,
      timeoutMs: queryTimeoutMs(params.timeout_ms),
      allowError: true,
    });

    if (!snippet.ok) throw new Error(errorText(snippet.data));
    return { data: isRecord(snippet.data) ? snippet.data : { snippet: snippet.data }, stderr: snippet.stderr };
  }

  private async readResolvedCandidate(candidate: SearchCandidate, project: string, params: Record<string, unknown>, ctx: ToolExecutionContext): Promise<BatchCallResult> {
    const snippet = await this.readQualifiedName(String(candidate.qualified_name), project, params, ctx, false);
    const neighbors = await this.symbolNeighbors(String(candidate.qualified_name), project, params, ctx);
    return { data: { ...snippet.data, ...neighbors.data }, stderr: `${snippet.stderr}${neighbors.stderr}` };
  }

  private async readOneSymbol(
    request: Record<string, unknown>,
    project: string,
    params: Record<string, unknown>,
    ctx: ToolExecutionContext,
    index: number,
  ): Promise<Record<string, unknown> & { stderr: string }> {
    const resolution = await this.resolveCandidates({ ...params, ...request, project }, ctx);
    const includeMetadata = params.include_metadata === true;

    if (resolution.candidates.length === 0) {
      return {
        index,
        request,
        status: "not_found",
        query: resolution.query,
        considered_candidates: resolution.consideredCandidates,
        hint: "Try search_graph with a broader query or fewer disambiguators.",
        stderr: resolution.stderr,
      };
    }

    if (resolution.candidates.length !== 1) {
      return {
        index,
        request,
        status: "ambiguous",
        query: resolution.query,
        considered_candidates: resolution.consideredCandidates,
        candidates: resolution.candidates.map((candidate) => compactResolveCandidate(candidate, includeMetadata)),
        hint: "Multiple matching symbols found. Retry with file_path, parent_class, label, route_path, route_method, or qualified_name.",
        stderr: resolution.stderr,
      };
    }

    const candidate = resolution.candidates[0]!;
    const read = await this.readResolvedCandidate(candidate, project, params, ctx);
    return {
      index,
      request,
      status: "ok",
      resolved: compactResolveCandidate(candidate, includeMetadata),
      snippet: read.data,
      stderr: `${resolution.stderr}${read.stderr}`,
    };
  }

  private async directNeighbors(
    data: unknown,
    key: "callers" | "callees",
    limit: number,
    includeMetadata: boolean,
    project: string,
    params: Record<string, unknown>,
    ctx: ToolExecutionContext,
    cache: LocationCache,
  ): Promise<Record<string, unknown>[] | undefined> {
    if (!isRecord(data) || !Array.isArray(data[key])) return undefined;
    const candidates = data[key].slice(0, limit).map((item) => {
      if (!isRecord(item)) return { name: String(item) };
      return item as SearchCandidate;
    });
    const enriched = await this.enrichCandidatesWithLocations(candidates, project, ctx, params, cache);
    return enriched.map((candidate) => compactResolveCandidate(candidate, includeMetadata));
  }

  private async symbolNeighbors(
    qualifiedName: string,
    project: string,
    params: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<{ data: Record<string, unknown>; stderr: string }> {
    const neighbors = requestedNeighbors(params);
    const direction = neighborDirection(neighbors);
    if (!direction) return { data: {}, stderr: "" };

    const limit = clampInt(params.neighbor_limit, 10, 1, 50);
    const trace = await this.cbm.callTool(
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
    const callers = neighbors === "callers" || neighbors === "both" ? await this.directNeighbors(trace.data, "callers", limit, includeMetadata, project, params, ctx, cache) : undefined;
    const callees = neighbors === "callees" || neighbors === "both" ? await this.directNeighbors(trace.data, "callees", limit, includeMetadata, project, params, ctx, cache) : undefined;

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
}
