import { tool } from "ai";
import { z } from "zod";
import type { IntegrationRegistry } from "../integrations/registry.js";

/**
 * Create enable_integration and disable_integration tools.
 * These mutate the session's active integrations set so that
 * subsequent runs include/exclude the integration tools.
 */
export function createIntegrationToggleTools(
  registry: IntegrationRegistry,
  activeIntegrations: Set<string>,
) {
  const available = registry.names;
  const availableList = available.join(", ");

  const enableIntegration = tool({
    description:
      `Enable an integration for this session. Available: ${availableList}. ` +
      `Once enabled, the integration's tools will be available in subsequent messages.`,
    inputSchema: z.object({
      name: z.string().describe("Integration name to enable"),
    }),
    execute: async ({ name }) => {
      const normalized = name.toLowerCase();
      if (!registry.has(normalized)) {
        return `Unknown integration "${name}". Available: ${availableList}`;
      }
      if (activeIntegrations.has(normalized)) {
        return `Integration "${normalized}" is already enabled.`;
      }
      activeIntegrations.add(normalized);
      const integration = registry.get(normalized)!;
      const toolNames = Object.keys(integration.tools.tools).join(", ");
      return `Integration "${normalized}" enabled. Tools now available: ${toolNames}`;
    },
  });

  const disableIntegration = tool({
    description:
      `Disable an integration for this session. ` +
      `Once disabled, the integration's tools will no longer be available.`,
    inputSchema: z.object({
      name: z.string().describe("Integration name to disable"),
    }),
    execute: async ({ name }) => {
      const normalized = name.toLowerCase();
      if (!activeIntegrations.has(normalized)) {
        return `Integration "${normalized}" is not currently enabled.`;
      }
      activeIntegrations.delete(normalized);
      return `Integration "${normalized}" disabled.`;
    },
  });

  return { enable_integration: enableIntegration, disable_integration: disableIntegration };
}
