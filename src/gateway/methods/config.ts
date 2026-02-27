import type { ConfigStore } from "../../config/store.js";
import type { Agent } from "../../brain/agent.js";
import { emit } from "../../events.js";
import { DEFAULT_TEAM_ID } from "../../config/agent-config.js";

/** Keys whose change affects the default team shown in the chat picker. */
const DEFAULT_TEAM_KEYS = new Set(["model", "identity"]);

export function configMethods(store: ConfigStore, getAgent: () => Agent) {
  return {
    /** Return full config with secret values redacted. Teams live in TeamStore now. */
    "config.get": async () => {
      const config = store.getRedacted();
      return { config };
    },

    /** Merge partial update into config. Restores redacted secrets before saving. */
    "config.patch": async (params: { patch: Record<string, unknown> }) => {
      const touchesDefault = Object.keys(params.patch).some((k) => DEFAULT_TEAM_KEYS.has(k));
      store.patchFromUI(params.patch);
      if (touchesDefault) {
        // Force agent to reload so getTeams() returns the new modelId
        await getAgent().forceConfigReload();
        emit("teamChange", { action: "updated", teamId: DEFAULT_TEAM_ID });
      }
      return { config: store.getRedacted() };
    },
  };
}
