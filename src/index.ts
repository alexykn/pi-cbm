import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { OutputService } from "./domain/output.js";
import { ProjectService } from "./domain/project.js";
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
  const projects = new ProjectService(cbm, settings);
  const output = new OutputService();
  const symbols = new SymbolService(cbm, projects, output);
  const trace = new TraceService(cbm, projects, output, symbols);
  const query = new QueryService(cbm, projects, output, trace);
  const services = { cbm, projects, output, symbols, trace, query, settings };

  registerCodebaseMemoryTools(pi, services);
  registerCommands(pi, services);
  registerLifecycle(pi, services);
}
