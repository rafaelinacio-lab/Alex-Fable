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
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { agentEventBus, type AgentEvent } from "../observability/eventBus.js";
import type { MovideskAgentSession } from "../agent/orchestrator.js";
import { DEFAULT_EXPORTS_DIR } from "../local/exportsDir.js";
import {
  listFollowUpProfiles,
  createFollowUpProfile,
  updateFollowUpProfile,
  deleteFollowUpProfile,
  type FollowUpProfileInput,
} from "../config/followUpProfiles.js";
import { runFollowUpCheck } from "../agent/followUp.js";
import { isFollowUpAutomationEnabled } from "../config/followUp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "..", "..", "public", "dashboard.html");

const CONTENT_TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
};

const EVENT_HISTORY_LIMIT = 500;
const eventHistory: AgentEvent[] = [];

agentEventBus.on("event", (event: AgentEvent) => {
  eventHistory.push(event);
  if (eventHistory.length > EVENT_HISTORY_LIMIT) eventHistory.shift();
});

/** Lê e faz parse do corpo JSON de uma requisição (sem lib externa — corpo é sempre pequeno aqui). */
async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error" | "file" | "system";
  text: string;
  timestamp: string;
  source: "web" | "terminal" | "system";
  /** Presente só quando role === "file" — ver AgentEvent "file_ready". */
  file?: { filename: string; downloadUrl: string; rowCount: number; format: "xlsx" | "pdf" };
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
  /** Publica um aviso na aba Conversa SEM passar pelo agente (não é um turno de usuário) —
   * usado por automações de fundo, ex: o resumo de cada rodada da cobrança automática
   * (ver src/agent/followUpScheduler.ts). Aparece com estilo diferenciado ("automação"). */
  announceSystemMessage(text: string): void;
  /** Encerra o servidor HTTP e os WebSockets — usado em testes; o CLI normalmente deixa rodando. */
  close(): Promise<void>;
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

    if (req.url?.startsWith("/exports/")) {
      // path.basename() descarta qualquer diretório embutido no nome — nunca serve nada
      // fora de DEFAULT_EXPORTS_DIR, mesmo que o navegador mande "../../etc/passwd" etc.
      const requested = decodeURIComponent(req.url.slice("/exports/".length));
      const filename = path.basename(requested);
      const filePath = path.join(DEFAULT_EXPORTS_DIR, filename);
      const ext = path.extname(filename).toLowerCase();
      const contentType = CONTENT_TYPES[ext];

      if (!contentType) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      stat(filePath)
        .then((stats) => {
          if (!stats.isFile()) throw new Error("not a file");
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": stats.size,
            "Content-Disposition": `attachment; filename="${filename}"`,
          });
          createReadStream(filePath).pipe(res);
        })
        .catch(() => {
          res.writeHead(404);
          res.end("arquivo não encontrado (pode ter sido removido)");
        });
      return;
    }

    if (req.url?.startsWith("/api/followup/")) {
      handleFollowUpApi(req, res).catch((err) => {
        const status = err instanceof Error && err.message.includes("não encontrado") ? 404 : 400;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  /**
   * API da aba "Automação" do painel — CRUD de perfis (equipe + regra de SLA) da
   * cobrança automática de retorno do cliente. Ver src/config/followUpProfiles.ts.
   */
  async function handleFollowUpApi(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["api","followup","profiles", id?, "run"?]
    const method = req.method ?? "GET";

    function json(status: number, body: unknown): void {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    }

    if (parts[2] !== "profiles") {
      json(404, { error: "rota não encontrada" });
      return;
    }

    const id = parts[3];

    if (!id && method === "GET") {
      const profiles = await listFollowUpProfiles();
      json(200, { profiles, automationEnabled: isFollowUpAutomationEnabled() });
      return;
    }

    if (!id && method === "POST") {
      const input = (await readJsonBody(req)) as FollowUpProfileInput;
      const created = await createFollowUpProfile(input);
      json(201, created);
      return;
    }

    if (id && parts[4] === "run" && method === "POST") {
      if (!isFollowUpAutomationEnabled()) {
        json(409, { error: "FOLLOWUP_AUTOMATION_ENABLED não está 'true' — a automação está desligada no ambiente." });
        return;
      }
      const profile = (await listFollowUpProfiles()).find((p) => p.id === id);
      if (!profile) {
        json(404, { error: `Perfil não encontrado: ${id}` });
        return;
      }
      const result = await runFollowUpCheck(profile);
      announceSystemMessage(
        `[${result.profileName} / ${result.ownerTeam}] Verificação manual concluída pelo painel. ` +
          `Chamados verificados: ${result.checkedCount}. Cobrados: ${result.charged.length}.`,
      );
      json(200, result);
      return;
    }

    if (id && method === "PUT") {
      const input = (await readJsonBody(req)) as FollowUpProfileInput;
      const updated = await updateFollowUpProfile(id, input);
      json(200, updated);
      return;
    }

    if (id && method === "DELETE") {
      await deleteFollowUpProfile(id);
      res.writeHead(204);
      res.end();
      return;
    }

    json(404, { error: "rota não encontrada" });
  }

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

  // Assim que um export (Excel/PDF) termina, mostra um cartão de download na aba
  // Conversa — independe de como o modelo descrever o resultado em texto.
  function onFileReady(event: AgentEvent): void {
    if (event.kind !== "file_ready") return;
    pushChat({
      role: "file",
      text: `Arquivo pronto: ${event.filename}`,
      timestamp: event.timestamp,
      source: "system",
      file: {
        filename: event.filename,
        downloadUrl: event.downloadUrl,
        rowCount: event.rowCount,
        format: event.format,
      },
    });
  }
  agentEventBus.on("event", onFileReady);

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

  function announceSystemMessage(text: string): void {
    pushChat({ role: "system", text, timestamp: new Date().toISOString(), source: "system" });
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

  async function close(): Promise<void> {
    agentEventBus.off("event", onFileReady);
    for (const client of chatClients) client.terminate();
    eventsWss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => eventsWss.close(() => resolve()));
    await new Promise<void>((resolve) => chatWss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { url: `http://localhost:${port}`, sendChatMessage, announceSystemMessage, close };
}
