import type { Agent } from "../../brain/agent.js";

export function toolMethods(getAgent: () => Agent) {
  return {
    "tools.list": async () => {
      return { tools: getAgent().getToolNames() };
    },
  };
}
