/**
 * CLI mínimo para testar o agente localmente via terminal (REPL simples).
 * Uso: npm run dev
 */

import "../config/loadEnv.js"; // precisa rodar antes de qualquer import que leia process.env

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MovideskAgentSession } from "./orchestrator.js";
import type { AgentContext } from "./tools.js";
import { startDashboardServer } from "../server/dashboard.js";

async function main() {
  const authenticatedUser: AgentContext["authenticatedUser"] = {
    id_local: process.env.DEV_USER_ID ?? "dev-local",
    username: process.env.DEV_USER_USERNAME ?? "dev.local",
    name: process.env.DEV_USER_NAME ?? "Usuário de Desenvolvimento",
    email: process.env.DEV_USER_EMAIL ?? "dev.local@viasoft.com.br",
  };

  // A sessão é criada ANTES do dashboard subir: terminal e aba "Conversa" do painel
  // conversam com a mesma sessão/mesmo histórico — não são dois agentes separados.
  const session = new MovideskAgentSession({
    conversationId: `cli-${Date.now()}`,
    authenticatedUser,
  });

  const dashboard = startDashboardServer(session);
  console.log(`Painel ao vivo: ${dashboard.url} (abra no navegador — dá pra conversar com o agente por lá também, na aba "Conversa")\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log("Agente Movidesk (dev) — digite sua mensagem. Ctrl+C para sair.\n");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userText = await rl.question("Você: ");
    if (!userText.trim()) continue;
    try {
      const reply = await dashboard.sendChatMessage(userText, "terminal");
      console.log(`\nAgente: ${reply}\n`);
    } catch (err) {
      console.error(`\nErro ao processar mensagem: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Erro fatal no CLI do agente:", err);
  process.exit(1);
});
