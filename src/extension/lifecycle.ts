import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";
import { CODEBASE_MEMORY_PROMPT } from "./prompt.js";

const AUTO_REFRESH_INTERVAL_MS = 60_000;

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let indexInFlight = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  async function indexCurrentRepo(ctx: ExtensionContext) {
    if (indexInFlight || ctx.signal?.aborted) return;

    indexInFlight = true;
    try {
      const result = await services.projects.indexCurrentRepo(ctx.cwd, ctx.signal);
      const nodes = typeof result.nodes === "number" ? ` · ${result.nodes} nodes` : "";
      const edges = typeof result.edges === "number" ? ` · ${result.edges} edges` : "";
      ctx.ui.setStatus("codebase-memory", `cbm ${result.project}${nodes}${edges}`);
    } catch {
      ctx.ui.setStatus("codebase-memory", "cbm index failed");
    } finally {
      indexInFlight = false;
    }
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT,
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
