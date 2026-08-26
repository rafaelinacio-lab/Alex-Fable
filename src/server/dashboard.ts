/**
 * Servidor do dashboard: serve a página HTML e mantém DOIS canais WebSocket:
 *
 *  - `/ws`   → transmite eventos de observabilidade (chamadas de ferramenta e de API),
 *              já sanitizados — sem token, sem segredos (ver ../observability/eventBus.js).
 *  - `/chat` → aba de conversa: mensagens do navegador chegam aqui e são repassadas para
 *              a MESMA sessão do agente usada pelo terminal (`MovideskAgentSession`), então
 *              terminal e navegador conversam com o mesmo agente, na mesma conversa —
 *              não são duas sessões/duas contagens de rate limit separadas.
 *
 * Roda no mesmo processo do agente, então basta chamar `startDashboardServer(session)`
 * uma vez no ponto de entrada (ex: `src/agent/cli.ts`), passando a sessão já criada.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { agentEventBus, type AgentEvent } from "../observability/eventBus.js";
import type { MovideskAgentSession } from "../agent/orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "..", "..", "public", "dashboard.html");

const EVENT_HISTORY_LIMIT = 500;
const eventHistory: AgentEvent[] = [];

agentEventBus.on("event", (event: AgentEvent) => {
  eventHistory.push(event);
  if (eventHistory.length > EVENT_HISTORY_LIMIT) eventHistory.shift();
});

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  timestamp: string;
  source: "web" | "terminal";
}

const CHAT_HISTORY_LIMIT = 200;
const chatHistory: ChatMessage[] = [];
let chatSeq = 0;

export interface DashboardHandle {
  url: string;
  /** Envia uma mensagem de usuário para a sessão do agente e transmite o par pergunta/resposta
   * para todas as abas de conversa conectadas. Use isto no lugar de `session.send()` diretamente
   * sempre que a mensagem também deve aparecer no painel web (ex: o REPL de terminal). */
  sendChatMessage(text: string, source: ChatMessage["source"]): Promise<string>;
}

export function startDashboardServer(
  session: MovideskAgentSession,
  port = Number(process.env.DASHBOARD_PORT ?? 4590),
): DashboardHandle {
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

  // --- canal de eventos (aba "Atividade") ---
  // noServer:true nas duas instâncias + roteamento manual pelo path abaixo, porque duas
  // WebSocketServer com `{ server, path }` competindo pelo mesmo evento 'upgrade' do
  // http.Server não roteiam de forma confiável (observado: handshake falhando com 400).
  const eventsWss = new WebSocketServer({ noServer: true });
  const chatWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "";
    if (pathname === "/ws") {
      eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit("connection", ws, req));
    } else if (pathname === "/chat") {
      chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  eventsWss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "history", events: eventHistory }));
    const onEvent = (event: AgentEvent) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "event", event }));
      }
    };
    agentEventBus.on("event", onEvent);
    socket.on("close", () => agentEventBus.off("event", onEvent));
  });

  // --- canal de conversa (aba "Conversa") ---
  const chatClients = new Set<WebSocket>();

  function broadcastChat(message: ChatMessage): void {
    const payload = JSON.stringify({ type: "chat_message", message });
    for (const client of chatClients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function pushChat(message: Omit<ChatMessage, "id">): ChatMessage {
    const full: ChatMessage = { id: String(++chatSeq), ...message };
    chatHistory.push(full);
    if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.shift();
    broadcastChat(full);
    return full;
  }

  async function sendChatMessage(text: string, source: ChatMessage["source"]): Promise<string> {
    pushChat({ role: "user", text, timestamp: new Date().toISOString(), source });
    try {
      const reply = await session.send(text);
      pushChat({ role: "assistant", text: reply, timestamp: new Date().toISOString(), source });
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushChat({ role: "error", text: message, timestamp: new Date().toISOString(), source });
      throw err;
    }
  }

  chatWss.on("connection", (socket: WebSocket) => {
    chatClients.add(socket);
    socket.send(JSON.stringify({ type: "chat_history", messages: chatHistory }));

    socket.on("message", (raw) => {
      let parsed: { type?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(raw.toString()) as { type?: unknown; text?: unknown };
      } catch {
        return;
      }
      if (parsed.type === "user_message" && typeof parsed.text === "string") {
        const text = parsed.text.trim();
        if (!text) return;
        // Não aguardamos aqui — a resposta chega via broadcast (o socket que enviou também
        // está em chatClients, então recebe a mesma mensagem que qualquer outra aba aberta).
        sendChatMessage(text, "web").catch(() => {
          /* erro já foi transmitido como chat_message role:"error" dentro de sendChatMessage */
        });
      }
    });

    socket.on("close", () => chatClients.delete(socket));
  });

  server.listen(port);
  return { url: `http://localhost:${port}`, sendChatMessage };
}
