import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { IndexCoordinator } from "./domain/index-coordinator.js";
import { OutputService } from "./domain/output.js";
import { IndexingService } from "./domain/indexing.js";
import { ProjectCatalog } from "./domain/project-catalog.js";
import { ProjectResolver } from "./domain/project-resolver.js";
import { QueryService } from "./domain/query.js";
import { SymbolService } from "./domain/symbols.js";
import { TraceService } from "./domain/trace.js";
import { registerCommands } from "./extension/commands.js";
import { registerLifecycle } from "./extension/lifecycle.js";
import { CbmRuntimeSettings } from "./extension/runtime-settings.js";
import { registerCodebaseMemoryTools } from "./pi-tools/registry.js";

export default function codebaseMemoryExtension(pi: ExtensionAPI) {
  const settings = new CbmRuntimeSettings();
  const cbm = new CbmClient();
  const indexCoordinator = new IndexCoordinator();
  const catalog = new ProjectCatalog(cbm);
  const resolver = new ProjectResolver(cbm, catalog);
  const indexing = new IndexingService(cbm, settings, indexCoordinator, catalog);
  const output = new OutputService();
  const symbols = new SymbolService(cbm, resolver, catalog, output);
  const trace = new TraceService(cbm, resolver, output, symbols);
  const query = new QueryService(cbm, resolver, catalog, indexing, output, trace);
  const services = { cbm, indexing, output, symbols, trace, query, settings };

  registerCodebaseMemoryTools(pi, services);
  registerCommands(pi, services);
  registerLifecycle(pi, services);
}
