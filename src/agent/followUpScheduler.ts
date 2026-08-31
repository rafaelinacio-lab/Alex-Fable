/**
 * Agendador da automação de cobrança (ver src/agent/followUp.ts e
 * src/config/followUp.ts). Só roda de fato se `FOLLOW_UP_CONFIG.enabled` for true —
 * chamar `startFollowUpScheduler()` fora disso é um no-op seguro.
 *
 * Cada execução é anunciada no painel (aba Conversa, via uma mensagem de sistema) para
 * que o resultado apareça sem o usuário precisar perguntar — consistente com o resto do
 * projeto (cartões de arquivo, atividade em tempo real).
 */

import { FOLLOW_UP_CONFIG } from "../config/followUp.js";
import { runFollowUpCheck, type FollowUpRunResult } from "./followUp.js";

export interface FollowUpScheduler {
  stop(): void;
}

function summarize(result: FollowUpRunResult): string {
  const lines = [
    `Verificação automática de chamados aguardando retorno/validação do cliente concluída.`,
    `Chamados verificados: ${result.checkedCount}.`,
  ];
  if (result.charged.length > 0) {
    lines.push(
      `Cobrados agora (${result.charged.length}): ` + result.charged.map((c) => `#${c.id}`).join(", ") + ".",
    );
  } else {
    lines.push("Nenhum chamado precisou de cobrança nesta rodada.");
  }
  if (result.errors.length > 0) {
    lines.push(
      `⚠ Falha ao cobrar ${result.errors.length} chamado(s): ` +
        result.errors.map((e) => `#${e.id} (${e.errorMessage})`).join("; ") +
        ".",
    );
  }
  return lines.join(" ");
}

/**
 * Inicia o agendador. `announce` é chamado com um resumo textual de cada rodada — o
 * chamador decide onde isso aparece (ex: `dashboard.sendChatMessage`, ver cli.ts).
 * Retorna um handle com `stop()`; se a automação estiver desligada, o intervalo nunca é
 * criado e `stop()` não faz nada.
 */
export function startFollowUpScheduler(announce: (text: string) => void): FollowUpScheduler {
  if (!FOLLOW_UP_CONFIG.enabled) {
    return { stop() {} };
  }

  async function runOnce(): Promise<void> {
    try {
      const result = await runFollowUpCheck();
      announce(summarize(result));
    } catch (err) {
      announce(
        `⚠ Verificação automática de cobrança falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const intervalMs = FOLLOW_UP_CONFIG.checkIntervalHours * 60 * 60 * 1000;
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.(); // não impede o processo de encerrar (ex: Ctrl+C no CLI)

  // Roda uma vez logo na subida também, para dar sinal de vida (não espera 24h pela primeira rodada).
  void runOnce();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
