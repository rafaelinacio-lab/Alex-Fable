/**
 * Servidor do dashboard de observabilidade: serve a página HTML e transmite, via
 * WebSocket, todo evento publicado em `agentEventBus` (chamadas de ferramenta e
 * chamadas HTTP ao Movidesk), já sanitizado — sem token, sem segredos.
 *
 * Roda no mesmo processo do agente (importa o mesmo `eventBus` singleton), então basta
 * chamar `startDashboardServer()` uma vez no ponto de entrada (ex: `src/agent/cli.ts`).
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { agentEventBus, type AgentEvent } from "../observability/eventBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "..", "..", "public", "dashboard.html");

const HISTORY_LIMIT = 500;
const history: AgentEvent[] = [];

agentEventBus.on("event", (event: AgentEvent) => {
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
});

export function startDashboardServer(port = Number(process.env.DASHBOARD_PORT ?? 4590)): { url: string } {
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/dashboard.html") {
      readFile(DASHBOARD_HTML_PATH, "utf8")
        .then((html) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        })
        .catch(() => {
          res.writeHead(404);
          res.end("dashboard.html não encontrado");
        });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket) => {
    // Ao conectar, manda o histórico recente para a página já abrir com contexto.
    socket.send(JSON.stringify({ type: "history", events: history }));

    const onEvent = (event: AgentEvent) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "event", event }));
      }
    };
    agentEventBus.on("event", onEvent);
    socket.on("close", () => agentEventBus.off("event", onEvent));
  });

  server.listen(port);
  return { url: `http://localhost:${port}` };
}
