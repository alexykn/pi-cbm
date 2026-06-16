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
- Prefer codebase-memory tools over default grep/read/find when doing code discovery, symbol lookup, caller/callee tracing, architecture exploration, literal code search, or impact analysis.
- The current cwd project is auto-indexed in full mode in the background at startup and periodically refreshed, so you normally do not need to call index_repository for the active project.
- For cwd/current-project tools, omit the project parameter; the plugin infers it automatically. Provide project only when intentionally querying an external indexed project.
- Use index_repository mainly for external repository paths or explicit manual refreshes.
- Use get_architecture for orientation, search_graph for symbols/classes/functions/routes/handlers, get_code_snippet after search_graph finds a qualified_name, trace_path for callers/callees/dependency tracing, search_code for literal search in indexed code, and query_graph for custom graph/Cypher questions after get_graph_schema.
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
