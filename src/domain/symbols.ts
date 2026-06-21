import { CbmClient } from "../cbm/client.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { clampInt } from "../shared/numbers.js";
import { isRecord, numberProp, removeUndefined, stringProp } from "../shared/object.js";
import { errorText, escapeRegExp, normalizeForMatch } from "../shared/strings.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type ToolExecutionContext } from "./project.js";

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

    const candidates: SearchCandidate[] = [];
    let stderr = "";
    for (const search of searches) {
      const result = await this.cbm.callTool(
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
    const snippetArgs = removeUndefined({
      project: resolution.project,
      qualified_name: candidate.qualified_name,
    });
    const snippet = await this.cbm.callTool("get_code_snippet", snippetArgs, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
    const neighbors = await this.symbolNeighbors(String(candidate.qualified_name), resolution.project, params, ctx);
    const resolved = compactResolveCandidate(candidate, params.include_metadata === true);
    const data = isRecord(snippet.data) ? { resolved, ...snippet.data, ...neighbors.data } : { resolved, snippet: snippet.data, ...neighbors.data };

    return this.output.buildCompactableToolResult("Symbol source", data, params, {
      tool: "read_symbol",
      args: removeUndefined({ project: resolution.project, ...stripOutputControls(params) }),
      snippet_args: snippetArgs,
      stderr: `${resolution.stderr}${snippet.stderr}${neighbors.stderr}`,
    });
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
    return removeUndefined({ ...params, project: await this.projects.inferProject(ctx.cwd, ctx.signal) });
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
