import { emit } from "../../events.js";
import { onClientClose } from "../broadcast.js";
import { logger, getLogBuffer, addLogSubscriber, type LogEntry } from "../../logger.js";
import type { RpcContext } from "../rpc.js";

export function systemMethods(restart: () => Promise<void>, ctx?: RpcContext) {
  return {
    /** Hot-restart all backend components. WebSocket connections stay alive. */
    "system.restart": async () => {
      logger.info("Hot restart requested via RPC");
      emit("system", { action: "restarting" });

      // Run restart in background so the RPC response is sent first
      setTimeout(async () => {
        try {
          await restart();
          emit("system", { action: "restarted" });
          logger.info("Hot restart complete");
        } catch (err) {
          logger.error(`Hot restart failed: ${err}`);
          emit("system", { action: "restart_failed", error: String(err) });
        }
      }, 0);

      return { status: "restarting" };
    },

    /** Return buffered log history and subscribe the caller to real-time log events. */
    "system.logs.subscribe": async () => {
      const ws = ctx?.ws;
      if (ws) {
        const send = (entry: LogEntry) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "event", event: "log", payload: entry }));
          }
        };
        const unsub = addLogSubscriber(send);
        onClientClose(ws, unsub);
      }
      return { logs: getLogBuffer() };
    },
  };
}
