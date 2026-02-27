import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Agent } from "../brain/agent.js";
import { addClient, broadcast } from "./broadcast.js";
import { createRpcDispatcher, type RpcOptions } from "./rpc.js";
import { on } from "../events.js";
import { logger } from "../logger.js";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

interface GatewayServerOptions extends RpcOptions {
  host?: string;
}

/** Bridge app-level events to WebSocket broadcast. */
const BRIDGED_EVENTS = ["taskChange", "teamChange", "promptTemplateChange", "playbookChange", "system", "agent", "chat", "whatsapp"];
for (const event of BRIDGED_EVENTS) {
  on(event, (payload) => broadcast(event, payload));
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Resolve the control-ui dist directory (lives next to compiled gateway code). */
function getUiDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/gateway/server.js -> dist/control-ui
  return join(thisFile, "..", "..", "control-ui");
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uiDir = resolve(getUiDir());
  const url = req.url ?? "/";
  const pathname = decodeURIComponent(url.split("?")[0]);

  // Resolve and guard against path traversal
  let filePath = resolve(uiDir, pathname.replace(/^\/+/, "") || "index.html");
  if (!filePath.startsWith(uiDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream", ...SECURITY_HEADERS });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for non-asset routes
    try {
      const indexPath = join(uiDir, "index.html");
      const content = await readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html", ...SECURITY_HEADERS });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}

export function startGateway(
  port: number,
  token: string,
  getAgent: () => Agent,
  opts: GatewayServerOptions = {},
) {
  const { host = DEFAULT_GATEWAY_HOST, ...rpcOptions } = opts;
  const WS_PATH = "/ws";

  const server = createServer(async (req, res) => {
    await serveStatic(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });
  const dispatch = createRpcDispatcher(getAgent, rpcOptions);

  // Only upgrade requests on the /ws path
  server.on("upgrade", (req, socket, head) => {
    if (req.url === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let authed = false;

    ws.on("message", async (raw) => {
      let msg: { id?: string; method?: string; params?: unknown; token?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ error: "invalid json" }));
        return;
      }

      // Auth handshake
      if (msg.method === "connect") {
        if (msg.token === token) {
          authed = true;
          addClient(ws);
          ws.send(JSON.stringify({ id: msg.id, result: { status: "ok" } }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, error: "auth failed" }));
          ws.close();
        }
        return;
      }

      if (!authed) {
        ws.send(JSON.stringify({ error: "not authenticated" }));
        return;
      }

      // RPC dispatch
      try {
        const result = await dispatch(msg.method!, msg.params, { ws });
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: err instanceof Error ? err.message : "unknown error",
          })
        );
      }
    });
  });

  server.listen(port, host, () => {
    logger.info(`Gateway listening on http://${host}:${port}`);
  });

  return server;
}
