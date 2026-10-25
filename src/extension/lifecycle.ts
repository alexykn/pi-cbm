import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";
import { cbmEnvPositiveInt, removedEnvWarning } from "../shared/env.js";
import { CODEBASE_MEMORY_PROMPT } from "./prompt.js";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const AUTO_REFRESH_INTERVAL_MS = cbmEnvPositiveInt("AUTO_REFRESH_INTERVAL_MS", DEFAULT_AUTO_REFRESH_INTERVAL_MS, MAX_TIMER_DELAY_MS);

type SessionResources = Pick<ExtensionContext, "cwd" | "signal" | "ui">;

function readSessionResources(ctx: ExtensionContext): SessionResources | undefined {
  try {
    return {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ui: ctx.ui,
    };
  } catch {
    // A session_start handler from an old runner can resume after reload and
    // receive a context that has already been invalidated.
    return undefined;
  }
}

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  // Monotonically increasing session generation. Bumped synchronously on every
  // session start and shutdown so that interval callbacks already queued or
  // still awaiting from a previous session can bail out before using old
  // session-bound resources.
  let sessionGeneration = 0;
  // The session generation that currently owns an in-flight index, used to keep
  // a single active index per session without leaking state across sessions.
  let inFlightGeneration: number | undefined;
  let removedEnvChecked = false;

  // Compatibility notices go to the user, not only into tool errors the agent sees.
  function showVersionNotices(session: SessionResources, generation: number) {
    if (generation !== sessionGeneration) return;
    for (const notice of services.cbm.takeVersionNotices()) session.ui.notify(notice.message, notice.level);
  }

  // Once per process: a leftover old variable name would otherwise be ignored silently.
  function warnAboutRemovedEnv(session: SessionResources) {
    if (removedEnvChecked) return;
    removedEnvChecked = true;
    const warning = removedEnvWarning();
    if (warning) session.ui.notify(warning, "warning");
  }

  async function checkVersion(session: SessionResources, generation: number) {
    try {
      await services.cbm.checkVersion(session.signal);
    } catch {
      // A missing binary or a cancelled session: the index status line reports it.
    }
    showVersionNotices(session, generation);
  }

  async function indexCurrentRepo(session: SessionResources, generation: number) {
    if (generation !== sessionGeneration) return; // stale session: skip
    if (inFlightGeneration === generation || session.signal?.aborted) return;

    inFlightGeneration = generation;
    try {
      const result = await services.indexing.indexCurrentRepo(session.cwd, session.signal);
      if (generation !== sessionGeneration) return; // session changed mid-run
      if (result.status === "skipped") {
        session.ui.setStatus("codebase-memory", `cbm skipped: ${result.reason}`);
        return;
      }
      if (result.status === "fresh") {
        session.ui.setStatus("codebase-memory", `cbm ${result.project} · up to date`);
        return;
      }

      const nodes = typeof result.nodes === "number" ? ` · ${result.nodes} nodes` : "";
      const edges = typeof result.edges === "number" ? ` · ${result.edges} edges` : "";
      session.ui.setStatus("codebase-memory", `cbm ${result.project}${nodes}${edges}`);
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
      session.ui.setStatus("codebase-memory", `cbm index failed${reason}`);
    } finally {
      if (inFlightGeneration === generation) inFlightGeneration = undefined;
      showVersionNotices(session, generation);
    }
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT,
  }));

  pi.on("session_start", (_event, ctx) => {
    const session = readSessionResources(ctx);
    if (!session) return;

    services.settings.reload();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;

    const generation = sessionGeneration + 1;
    sessionGeneration = generation;

    warnAboutRemovedEnv(session);
    void checkVersion(session, generation);
    void indexCurrentRepo(session, generation);
    refreshTimer = setInterval(() => {
      void indexCurrentRepo(session, generation);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    // Invalidate synchronously so already-queued/running callbacks from this
    // session give up instead of updating old session-bound resources.
    sessionGeneration += 1;
  });
}
