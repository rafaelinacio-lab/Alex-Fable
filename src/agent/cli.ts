/**
 * CLI mínimo para testar o agente localmente via terminal (REPL simples).
 * Uso: npm run dev
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MovideskAgentSession } from "./orchestrator.js";
import type { AgentContext } from "./tools.js";

async function main() {
  const authenticatedUser: AgentContext["authenticatedUser"] = {
    id_local: process.env.DEV_USER_ID ?? "dev-local",
    username: process.env.DEV_USER_USERNAME ?? "dev.local",
    name: process.env.DEV_USER_NAME ?? "Usuário de Desenvolvimento",
    email: process.env.DEV_USER_EMAIL ?? "dev.local@viasoft.com.br",
  };

  const session = new MovideskAgentSession({
    conversationId: `cli-${Date.now()}`,
    authenticatedUser,
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log("Agente Movidesk (dev) — digite sua mensagem. Ctrl+C para sair.\n");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userText = await rl.question("Você: ");
    if (!userText.trim()) continue;
    const reply = await session.send(userText);
    console.log(`\nAgente: ${reply}\n`);
  }
}

main().catch((err) => {
  console.error("Erro fatal no CLI do agente:", err);
  process.exit(1);
});
