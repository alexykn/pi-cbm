import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callCbmTool, indexTimeoutMs } from "./cbm.js";
import { defaultRepoPath } from "./project.js";
import { registerCodebaseMemoryTools } from "./tools.js";

const AUTO_INDEX_MODE = "full";
const AUTO_REFRESH_INTERVAL_MS = 60_000;

export default function codebaseMemoryExtension(pi: ExtensionAPI) {
  let indexInFlight = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  async function indexCurrentRepo(ctx: ExtensionContext) {
    if (indexInFlight || ctx.signal?.aborted) return;

    indexInFlight = true;
    try {
      const repoPath = await defaultRepoPath(ctx.cwd, ctx.signal);
      if (ctx.signal?.aborted) return;

      const result = await callCbmTool(
        "index_repository",
        { repo_path: repoPath, mode: AUTO_INDEX_MODE },
        { signal: ctx.signal, timeoutMs: indexTimeoutMs(undefined) },
      );

      const data = result.data as Record<string, unknown>;
      const project = typeof data.project === "string" ? data.project : "ready";
      const nodes = typeof data.nodes === "number" ? ` · ${data.nodes} nodes` : "";
      const edges = typeof data.edges === "number" ? ` · ${data.edges} edges` : "";
      ctx.ui.setStatus("codebase-memory", `cbm ${project}${nodes}${edges}`);
    } catch {
      ctx.ui.setStatus("codebase-memory", "cbm index failed");
    } finally {
      indexInFlight = false;
    }
  }

  registerCodebaseMemoryTools(pi);

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      `

Codebase-memory guidance:
- Prefer codebase-memory tools over built-in grep/find/file-read for code exploration, symbol/workflow discovery, call tracing, and reading known symbols. Use normal file reads when the target is an obvious known file or non-symbol content.
- The current cwd project is auto-indexed in full mode in the background at startup and periodically refreshed, so you normally do not need to call index_repository for the active project.
- For cwd/current-project tools, omit the project parameter; the plugin infers it automatically. Provide project only when intentionally querying an external indexed project.
- Exploration tools default to compact, location-first output to save context. Set include_metadata=true only when raw graph metrics/fingerprints/full upstream metadata are needed.
- Compact output hides analysis metadata, not edit-critical location identity; symbol-like results should include file_path/start_line/end_line when available.
- If a codebase-memory result is compacted or truncated, retry the same codebase-memory tool with a higher max_symbol_lines or full_output=true before falling back to read/grep.

Use codebase-memory for symbol, workflow, relationship, indexed-text, and impact discovery:
- If given a concrete symbol/function/class/method name, prefer resolve_symbol or read_symbol before search_graph.
- Use search_graph when the target is conceptual, unknown, or a workflow rather than a known symbol name.
- For conceptual “where is X implemented/handled/performed?” questions, use search_graph first with a small limit, then read_symbol or get_code_snippet only for the likely target symbol.
- Use resolve_symbol when you know a symbol name but need the exact qualified_name or candidate list; add file_path, parent_class, label, route_path, or route_method to narrow ambiguous names.
- Use read_symbol when you know a symbol name plus enough disambiguators and want source only if the match is unambiguous.
- read_symbol fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use get_code_snippet with an exact qualified_name.
- Use get_code_snippet when you already have an exact qualified_name; prefer read_symbol when you have a concrete symbol name plus disambiguators but not the exact qualified_name.
- Use read_symbol neighbors='callers'/'callees'/'both' for direct, source-free callers/callees. Use trace_path only for multi-hop workflow, dependency, impact, data-flow, or cross-service tracing.
- Prefer read_symbol/get_code_snippet over raw file reads when the target is a symbol; prefer file reads for known files, configs, docs, manifests, and non-symbol content.
- For direct “what calls X?” or “what does X call?” questions about a known symbol, prefer read_symbol(neighbors='callers'/'callees'/'both'); use trace_path with shallow depth, usually 2–3, when multi-hop tracing is needed.
- If the query is a symbol name, prefer resolve_symbol/read_symbol; if it is an exact non-symbol string or you need all textual occurrences, use search_code.
- For exact strings, env vars, route literals, error messages, config keys, or template text, use search_code instead of search_graph.
- For broad architecture orientation in an unfamiliar repo, use get_architecture. Requested aspects may be absent if the index has no data for them; use search_graph/query_graph for targeted route/entry-point lookup.
- For custom graph questions or aggregates, use get_graph_schema before query_graph and keep returned columns narrow.
- For local diff review or blast-radius analysis, use detect_changes.
- Use list_projects or index_status only when project inference/index readiness is uncertain or a graph query fails unexpectedly.

When not to use codebase-memory:
- If the user asks about README/package/deployment/config manifests and the file path is obvious, read the file directly.
- If the task is to run tests, build, lint, or inspect filesystem state, use shell tools.
- If a graph search returns no results, check spelling and index_status before refreshing indexes.

Admin/side-effect rules:
- Do not run index_repository for the active cwd project unless the user asks for a manual refresh or the index is confirmed stale; use it mainly for external repositories.
- Use manage_adr update/store only when the user explicitly wants to persist an architectural decision.
- Do not use ingest_traces unless the user explicitly provides traces or asks to test trace ingestion.
- Never use delete_project unless the user explicitly requests deletion and confirms the exact project name.
`,
  }));

  pi.on("session_start", (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);

    void indexCurrentRepo(ctx);
    refreshTimer = setInterval(() => {
      void indexCurrentRepo(ctx);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
