/**
 * "Última verificação" — o que a automação examinou na rodada mais recente, mesmo os
 * chamados que ela decidiu NÃO tocar (dentro do prazo, justification errada, etc).
 *
 * Existe porque `FollowUpRunResult` (ver src/agent/followUp.ts) só existia como retorno
 * de função — visível na hora (alert do painel, resumo na aba Conversa, evento na aba
 * Atividade), mas não ficava consultável depois. Pedido do usuário: uma área no painel
 * para ver quais chamados foram PROCESSADOS na última rodada (não só os
 * cobrados/fechados) e quanto falta para cobrar/encerrar cada um.
 *
 * Guarda só a ÚLTIMA rodada de cada perfil (sobrescreve, não acumula histórico) — é uma
 * foto do estado mais recente, não um log de auditoria (isso já existe em
 * src/store/audit.ts para as mutações reais).
 *
 * Os limiares (`thresholdBusinessHours`/`autoCloseThresholdHours`) ficam gravados AQUI,
 * junto com cada rodada — snapshot do que foi de fato usado naquela verificação — para o
 * painel calcular "faltam Xh para cobrar/fechar" sem precisar reconsultar o perfil (que
 * pode já ter sido editado desde então).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RunLogTicket {
  id: number;
  subject: string;
  status?: string;
  elapsedBusinessHours?: number;
  action: string;
  errorMessage?: string;
}

export interface ChargeRunLog {
  profileId: string;
  profileName: string;
  scopeLabel: string;
  ranAt: string;
  checkedCount: number;
  /** Prazo de cobrança usado nesta rodada, em horas úteis. */
  thresholdBusinessHours: number;
  /** Se o fechamento automático estava ligado (perfil E gate global) nesta rodada. */
  autoCloseEnabled: boolean;
  /** Prazo de fechamento usado nesta rodada, já convertido para horas úteis (a partir de
   * `autoCloseThresholdBusinessDays` + o expediente do perfil) — evita o painel precisar
   * conhecer a janela de expediente só para essa conta. */
  autoCloseThresholdHours: number;
  tickets: RunLogTicket[];
}

const CHARGE_RUNS_FILE = process.env.FOLLOWUP_LAST_CHARGE_RUNS_FILE ?? "./data/local/followup_last_charge_runs.json";

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/** Grava a última rodada de cobrança/fechamento de um perfil, substituindo a anterior DAQUELE perfil. */
export async function recordChargeRun(entry: ChargeRunLog, file = CHARGE_RUNS_FILE): Promise<void> {
  const all = await readJson<ChargeRunLog[]>(file, []);
  const next = all.filter((r) => r.profileId !== entry.profileId);
  next.push(entry);
  await writeJson(file, next);
}

export async function listChargeRuns(file = CHARGE_RUNS_FILE): Promise<ChargeRunLog[]> {
  return readJson<ChargeRunLog[]>(file, []);
}
