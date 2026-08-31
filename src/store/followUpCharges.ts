/**
 * Rastreamento de chamados que já receberam a cobrança automática (ver src/agent/followUp.ts).
 *
 * Existe para dar suporte a DUAS necessidades que a auditoria (store/audit.ts) não cobre
 * sozinha, porque ela é um log append-only, não um estado consultável:
 *
 *  1. Painel — área "Cobranças" que lista os chamados cobrados e quanto tempo falta até
 *     o fechamento automático (pedido do usuário).
 *  2. O próprio fechamento automático (src/agent/followUpClose.ts) precisa saber QUANDO
 *     cada chamado foi cobrado para calcular o prazo — sem isso não haveria como saber
 *     se "já passaram 24h úteis desde a cobrança" sem reprocessar todo o histórico do
 *     chamado a cada checagem.
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

export async function listPendingCharges(file = DEFAULT_FILE): Promise<ChargeRecord[]> {
  return (await readAll(file)).filter((r) => r.status === "pending");
}

/** Atualiza o desfecho de uma cobrança pendente (chamada pelo motor de fechamento
 * automático — src/agent/followUpClose.ts). No-op silencioso se o registro não existir
 * mais (ex: apagado manualmente) — nunca deve travar a checagem por isso. */
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
