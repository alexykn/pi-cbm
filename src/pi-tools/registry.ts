import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolDefinitions, type CbmServices } from "./definitions.js";

export function registerCodebaseMemoryTools(pi: ExtensionAPI, services: CbmServices) {
  for (const definition of toolDefinitions) {
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: definition.promptGuidelines,
      parameters: definition.parameters as any,
      async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
        return definition.execute(params, services, { cwd: ctx.cwd, signal: ctx.signal });
      },
      renderCall: definition.renderCall as any,
      renderResult: definition.renderResult as any,
    });
  }
}
