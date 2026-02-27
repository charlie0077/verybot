import type { WebSocket } from "ws";

const clients = new Set<WebSocket>();
const cleanups = new Map<WebSocket, Set<() => void>>();

export function addClient(ws: WebSocket) {
  clients.add(ws);
  ws.on("close", () => {
    clients.delete(ws);
    const fns = cleanups.get(ws);
    if (fns) {
      for (const fn of fns) fn();
      cleanups.delete(ws);
    }
  });
}

/** Register a cleanup callback that fires when a specific WS disconnects. */
export function onClientClose(ws: WebSocket, fn: () => void) {
  let set = cleanups.get(ws);
  if (!set) {
    set = new Set();
    cleanups.set(ws, set);
  }
  set.add(fn);
}

export function broadcast(event: string, payload: unknown, excludeWs?: WebSocket) {
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const ws of clients) {
    if (ws === excludeWs) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}
