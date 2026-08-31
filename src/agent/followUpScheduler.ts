/**
 * Agendador da automação de cobrança (ver src/agent/followUp.ts, src/config/followUp.ts
 * e src/config/followUpProfiles.ts). Como agora existem VÁRIOS perfis (um por equipe),
 * cada um com seu próprio `checkIntervalHours`, o agendador não usa mais um único
 * `setInterval` do tamanho do intervalo — ele "bate" (tick) com frequência fixa e curta
 * (`TICK_MINUTES`) e, a cada batida, decide quais perfis já venceram o próprio intervalo
 * (`lastRunAt` + `checkIntervalHours`) e só roda esses.
 *
 * Só roda de fato se `isFollowUpAutomationEnabled()` for true — chamar
 * `startFollowUpScheduler()` fora disso é um no-op seguro (ainda faz sentido chamar
 * sempre: o gate pode ser reativado sem reiniciar o processo... exceto que hoje É lido
 * uma vez aqui. Ver nota abaixo.).
 *
 * Cada execução é anunciada no painel (aba Conversa, via uma mensagem de sistema) para
 * que o resultado apareça sem o usuário precisar perguntar — consistente com o resto do
 * projeto (cartões de arquivo, atividade em tempo real).
 */

import { isFollowUpAutomationEnabled } from "../config/followUp.js";
import { listFollowUpProfiles, type FollowUpProfile } from "../config/followUpProfiles.js";
import { runFollowUpCheck, type FollowUpRunResult } from "./followUp.js";

export interface FollowUpScheduler {
  stop(): void;
}

const TICK_MINUTES = Number(process.env.FOLLOWUP_TICK_MINUTES ?? 15);

function summarize(result: FollowUpRunResult): string {
  const lines = [
    `[${result.profileName} / ${result.ownerTeam}] Verificação automática de cobrança concluída.`,
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

function isDue(profile: FollowUpProfile, now: Date): boolean {
  if (!profile.lastRunAt) return true; // nunca rodou — roda já na primeira batida.
  const elapsedMs = now.getTime() - new Date(profile.lastRunAt).getTime();
  return elapsedMs >= profile.checkIntervalHours * 60 * 60 * 1000;
}

/**
 * Inicia o agendador. `announce` é chamado com um resumo textual de cada rodada — o
 * chamador decide onde isso aparece (ex: `dashboard.announceSystemMessage`, ver
 * cli.ts). Retorna um handle com `stop()`; se a automação estiver desligada, o
 * intervalo nunca é criado e `stop()` não faz nada.
 */
export function startFollowUpScheduler(announce: (text: string) => void): FollowUpScheduler {
  if (!isFollowUpAutomationEnabled()) {
    return { stop() {} };
  }

  async function tick(): Promise<void> {
    // Lido a cada batida (não só na subida) — permite desligar o gate global sem
    // reiniciar o processo; religar exige reiniciar, já que o timer só é criado uma vez
    // em startFollowUpScheduler (aceitável: é o mesmo gate de segurança que já exige
    // opt-in explícito, então uma reinicialização para religar não é um problema real).
    if (!isFollowUpAutomationEnabled()) return;
    let profiles: FollowUpProfile[];
    try {
      profiles = await listFollowUpProfiles();
    } catch (err) {
      announce(
        `⚠ Falha ao carregar perfis de cobrança automática: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const now = new Date();
    for (const profile of profiles) {
      if (!profile.enabled || !isDue(profile, now)) continue;
      try {
        const result = await runFollowUpCheck(profile);
        announce(summarize(result));
      } catch (err) {
        announce(
          `⚠ Verificação automática de cobrança falhou para "${profile.name}" (${profile.ownerTeam}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, TICK_MINUTES * 60 * 1000);
  timer.unref?.(); // não impede o processo de encerrar (ex: Ctrl+C no CLI)

  void tick(); // roda logo na subida — perfis vencidos (ou nunca rodados) são pegos já na primeira batida.

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
