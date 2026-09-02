/**
 * Rastreamento de chamados que já receberam a cobrança automática (ver src/agent/followUp.ts).
 *
 * Existe para o painel (aba "Cobranças") mostrar QUANDO cada chamado foi cobrado —
 * histórico consultável, diferente da auditoria (store/audit.ts), que é um log
 * append-only. Desde que cobrar e fechar passaram a ser decididos na MESMA passada por
 * chamado (evaluateTicket, direto do estado real do ticket — não depende mais de saber
 * "quando foi cobrado" para decidir fechar), este store deixou de ser necessário para a
 * DECISÃO de fechamento; `status`/`resolvedAt` continuam atualizados (por closeTicket)
 * só para o histórico não mostrar como "pendente" um chamado que já foi fechado.
 *
 * Implementação: arquivo JSON local, mesmo padrão de src/config/followUpProfiles.ts —
 * troque por um banco real em produção mantendo esta assinatura.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BusinessSchedule } from "../movidesk/businessHours.js";

export type ChargeStatus =
  | "pending" // cobrado, aguardando resposta do cliente ou vencimento do prazo de fechamento
  | "responded" // cliente (ou alguém que não o owner/remetente da automação) agiu depois da cobrança
  | "closed" // fechado automaticamente por falta de retorno
  | "closed_error" // tentativa de fechamento falhou (ver closeError)
  | "resolved_externally"; // alguém mudou o status manualmente antes do fechamento automático agir

export interface ChargeRecord {
  ticketId: number;
  profileId: string;
  profileName: string;
  subject: string;
  ownerTeam?: string;
  ownerId?: string;
  /** Snapshot do momento da cobrança — usado para calcular o prazo de fechamento mesmo
   * que o perfil seja editado depois (ex: prazo ou expediente alterados no painel). */
  chargedAt: string;
  thresholdBusinessHours: number;
  schedule: BusinessSchedule;
  reminderSenderId: string;
  status: ChargeStatus;
  /** Preenchido quando status vira "closed"/"closed_error"/"responded"/"resolved_externally". */
  resolvedAt?: string;
  closeError?: string;
}

const DEFAULT_FILE = process.env.FOLLOWUP_CHARGES_FILE ?? "./data/local/followup_charges.json";

async function readAll(file: string): Promise<ChargeRecord[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChargeRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(records: ChargeRecord[], file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(records, null, 2), "utf8");
}

/** Registra uma nova cobrança. Se já existir um registro "pending" para o mesmo ticket
 * (ex: reprocessamento), ele é substituído — só interessa a cobrança mais recente. */
export async function recordCharge(
  record: Omit<ChargeRecord, "status">,
  file = DEFAULT_FILE,
): Promise<void> {
  const all = await readAll(file);
  const next = all.filter((r) => !(r.ticketId === record.ticketId && r.status === "pending"));
  next.push({ ...record, status: "pending" });
  await writeAll(next, file);
}

export async function listCharges(file = DEFAULT_FILE): Promise<ChargeRecord[]> {
  return readAll(file);
}

/** Atualiza o desfecho de uma cobrança rastreada (chamada por closeTicket em
 * src/agent/followUp.ts quando um chamado já cobrado é fechado). No-op silencioso se o
 * registro não existir mais (ex: nunca foi cobrado antes, ou foi apagado manualmente) —
 * nunca deve travar o fechamento por isso. */
export async function updateChargeStatus(
  ticketId: number,
  patch: Pick<ChargeRecord, "status"> & Partial<Pick<ChargeRecord, "resolvedAt" | "closeError">>,
  file = DEFAULT_FILE,
): Promise<void> {
  const all = await readAll(file);
  const idx = all.findIndex((r) => r.ticketId === ticketId && r.status === "pending");
  if (idx === -1) return;
  all[idx] = { ...all[idx]!, ...patch };
  await writeAll(all, file);
}
