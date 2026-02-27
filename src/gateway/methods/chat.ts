import type { Agent } from "../../brain/agent.js";

export function chatMethods(getAgent: () => Agent) {
  return {
    "chat.send": async (params: { sessionKey: string; message: string; agentId?: string; images?: string[] }) => {
      const reply = await getAgent().handleGatewayMessage(
        params.sessionKey,
        params.message,
        params.agentId,
        params.images,
      );
      return { status: "ok", reply };
    },

    "chat.history": async (params: { sessionKey: string }) => {
      const session = getAgent().getSession(params.sessionKey);
      return { messages: session?.getMessages() ?? [] };
    },

    "chat.abort": async (params: { sessionKey: string }) => {
      const aborted = getAgent().abortSession(params.sessionKey);
      return { status: aborted ? "ok" : "no_active_run" };
    },

    "chat.learn": async (params: { sessionKey: string; topic?: string }) => {
      if (!params?.sessionKey || typeof params.sessionKey !== "string") {
        throw new Error("sessionKey is required and must be a string");
      }
      if (params?.topic !== undefined && typeof params.topic !== "string") {
        throw new Error("topic must be a string");
      }
      return getAgent().learnMemory(params.sessionKey, params.topic);
    },

    "chat.remember": async (params: { sessionKey: string; fact: string }) => {
      if (!params?.sessionKey || typeof params.sessionKey !== "string") {
        throw new Error("sessionKey is required and must be a string");
      }
      if (!params?.fact || typeof params.fact !== "string") {
        throw new Error("fact is required and must be a string");
      }
      return getAgent().rememberMemory(params.sessionKey, params.fact);
    },

    "chat.teams": async () => {
      return { teams: getAgent().getTeams() };
    },
  };
}
