/**
 * "Última verificação" — o que a automação examinou na rodada mais recente, mesmo os
 * chamados que ela decidiu NÃO tocar (dentro do prazo, justification errada, etc).
 *
 * Existe porque `FollowUpRunResult`/`AutoCloseRunResult` (ver src/agent/followUp.ts e
 * src/agent/followUpClose.ts) só existiam como retorno de função — visíveis na hora
 * (alert do painel, resumo na aba Conversa, evento na aba Atividade), mas não ficavam
 * consultáveis depois. Pedido do usuário: uma área no painel para ver quais chamados
 * foram PROCESSADOS na última rodada (não só os cobrados/fechados), quanto falta para
 * encerrar, e quando foi a última cobrança — as duas últimas já vêm de
 * src/store/followUpCharges.ts; isto aqui cobre "quais foram processados".
 *
 * Guarda só a ÚLTIMA rodada de cada tipo (sobrescreve, não acumula histórico) — é uma
 * foto do estado mais recente, não um log de auditoria (isso já existe em
 * src/store/audit.ts para as mutações reais).
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
  tickets: RunLogTicket[];
}

export interface CloseRunLog {
  ranAt: string;
  checkedCount: number;
  tickets: RunLogTicket[];
}

const CHARGE_RUNS_FILE = process.env.FOLLOWUP_LAST_CHARGE_RUNS_FILE ?? "./data/local/followup_last_charge_runs.json";
const CLOSE_RUN_FILE = process.env.FOLLOWUP_LAST_CLOSE_RUN_FILE ?? "./data/local/followup_last_close_run.json";

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

/** Grava a última rodada de COBRANÇA de um perfil, substituindo a anterior DAQUELE perfil. */
export async function recordChargeRun(entry: ChargeRunLog, file = CHARGE_RUNS_FILE): Promise<void> {
  const all = await readJson<ChargeRunLog[]>(file, []);
  const next = all.filter((r) => r.profileId !== entry.profileId);
  next.push(entry);
  await writeJson(file, next);
}

export async function listChargeRuns(file = CHARGE_RUNS_FILE): Promise<ChargeRunLog[]> {
  return readJson<ChargeRunLog[]>(file, []);
}

/** Grava a última rodada de FECHAMENTO (global — não é por perfil), substituindo a anterior. */
export async function recordCloseRun(entry: CloseRunLog, file = CLOSE_RUN_FILE): Promise<void> {
  await writeJson(file, entry);
}

export async function getLastCloseRun(file = CLOSE_RUN_FILE): Promise<CloseRunLog | undefined> {
  return readJson<CloseRunLog | undefined>(file, undefined);
}
