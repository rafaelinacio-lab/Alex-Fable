/**
 * Perfis de cobrança automática de retorno do cliente — um por equipe.
 *
 * Antes, a automação tinha uma única configuração fixa (uma equipe, uma regra de SLA)
 * vinda só de variáveis de ambiente (ver git history de src/config/followUp.ts). O
 * usuário pediu para configurar isso pelo painel, e poder ter VÁRIAS equipes rodando com
 * regras de SLA diferentes (ex: outra equipe com expediente diferente, prazo diferente).
 *
 * Implementação: um array de perfis persistido em arquivo JSON local (mesmo padrão de
 * src/local/contacts.ts / src/store/idempotency.ts — troque por um banco real em
 * produção, mantendo esta mesma assinatura). Cada perfil é independente: equipe
 * (ownerTeam), status monitorados, prazo em dias úteis, sua PRÓPRIA janela de expediente
 * (schedule), intervalo de verificação, remetente e se está ligado.
 *
 * O gate global `FOLLOWUP_AUTOMATION_ENABLED` (env) continua existindo como interruptor
 * geral — nenhum perfil roda se ele não for "true", mesmo que o perfil individual esteja
 * `enabled: true` no painel. É a camada de segurança que impede uma automação nova de
 * começar a falar com clientes reais sozinha só por já existir configurada.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SLA_SCHEDULE, type BusinessSchedule } from "../movidesk/businessHours.js";

export interface FollowUpProfile {
  id: string;
  /** Rótulo livre, só para exibição no painel (ex: "Sistemas Internos"). */
  name: string;
  /** Equipe (ownerTeam) à qual este perfil se restringe — nenhuma outra é tocada por ele. */
  ownerTeam: string;
  enabled: boolean;
  waitingStatuses: string[];
  thresholdBusinessDays: number;
  checkIntervalHours: number;
  reminderSenderId: string;
  reminderSenderName: string;
  /** Janela de expediente própria deste perfil — SLAs diferentes por equipe. */
  schedule: BusinessSchedule;
  /** Preenchido pelo agendador após cada execução — usado para saber quando rodar de novo. */
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type FollowUpProfileInput = Pick<
  FollowUpProfile,
  "name" | "ownerTeam" | "enabled" | "waitingStatuses" | "thresholdBusinessDays" | "checkIntervalHours" | "reminderSenderId" | "reminderSenderName" | "schedule"
>;

const PROFILES_FILE = process.env.FOLLOWUP_PROFILES_FILE ?? "./data/local/followup_profiles.json";

const DEFAULT_WAITING_STATUSES = ["Aguardando Retorno do Cliente", "Aguardando Validação do Cliente"];

/**
 * Perfil-semente, usado só quando o arquivo de perfis ainda não existe (primeira
 * execução após esta feature) — reaproduz a configuração original (única equipe,
 * variáveis de ambiente antigas), para não mudar o comportamento de quem já tinha isso
 * configurado antes de existir o painel. Depois da primeira leitura, o arquivo passa a
 * mandar; as variáveis de ambiente antigas (FOLLOWUP_OWNER_TEAM etc.) não são mais lidas.
 */
function seedProfile(): FollowUpProfile {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "Sistemas Internos",
    ownerTeam: process.env.FOLLOWUP_OWNER_TEAM ?? "VIASOFT - Sistemas Internos",
    enabled: true,
    waitingStatuses: DEFAULT_WAITING_STATUSES,
    thresholdBusinessDays: Number(process.env.FOLLOWUP_THRESHOLD_BUSINESS_DAYS ?? 3),
    checkIntervalHours: Number(process.env.FOLLOWUP_CHECK_INTERVAL_HOURS ?? 24),
    reminderSenderId: process.env.FOLLOWUP_SENDER_COD_REF ?? "007",
    reminderSenderName: "Alex Fable",
    schedule: SLA_SCHEDULE,
    createdAt: now,
    updatedAt: now,
  };
}

async function readProfiles(): Promise<FollowUpProfile[]> {
  try {
    const raw = await readFile(PROFILES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FollowUpProfile[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const seeded = [seedProfile()];
      await writeProfiles(seeded);
      return seeded;
    }
    throw err;
  }
}

async function writeProfiles(profiles: FollowUpProfile[]): Promise<void> {
  await mkdir(path.dirname(PROFILES_FILE), { recursive: true });
  await writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), "utf8");
}

export async function listFollowUpProfiles(): Promise<FollowUpProfile[]> {
  return readProfiles();
}

export async function getFollowUpProfile(id: string): Promise<FollowUpProfile | undefined> {
  const profiles = await readProfiles();
  return profiles.find((p) => p.id === id);
}

function validateInput(input: FollowUpProfileInput): void {
  if (!input.name.trim()) throw new Error("Nome do perfil não pode ser vazio.");
  if (!input.ownerTeam.trim()) throw new Error("ownerTeam (equipe) não pode ser vazio.");
  if (!input.waitingStatuses.length) throw new Error("Informe ao menos um status monitorado.");
  if (input.thresholdBusinessDays <= 0) throw new Error("thresholdBusinessDays deve ser positivo.");
  if (input.checkIntervalHours <= 0) throw new Error("checkIntervalHours deve ser positivo.");
  if (!input.reminderSenderId.trim()) throw new Error("reminderSenderId (cod_ref) não pode ser vazio.");
  const { morningStart, morningEnd, afternoonStart, afternoonEnd } = input.schedule;
  const ok =
    [morningStart, morningEnd, afternoonStart, afternoonEnd].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 24 * 60,
    ) &&
    morningStart < morningEnd &&
    morningEnd <= afternoonStart &&
    afternoonStart < afternoonEnd;
  if (!ok) {
    throw new Error(
      "Janela de expediente inválida — precisa ser morningStart < morningEnd <= afternoonStart < afternoonEnd, tudo em minutos desde a meia-noite (0-1440).",
    );
  }
}

export async function createFollowUpProfile(input: FollowUpProfileInput): Promise<FollowUpProfile> {
  validateInput(input);
  const profiles = await readProfiles();
  const now = new Date().toISOString();
  const profile: FollowUpProfile = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  profiles.push(profile);
  await writeProfiles(profiles);
  return profile;
}

export async function updateFollowUpProfile(
  id: string,
  input: FollowUpProfileInput,
): Promise<FollowUpProfile> {
  validateInput(input);
  const profiles = await readProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  const existing = profiles[idx];
  if (idx === -1 || !existing) throw new Error(`Perfil não encontrado: ${id}`);
  const updated: FollowUpProfile = {
    ...input,
    id,
    lastRunAt: existing.lastRunAt,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  profiles[idx] = updated;
  await writeProfiles(profiles);
  return updated;
}

export async function deleteFollowUpProfile(id: string): Promise<void> {
  const profiles = await readProfiles();
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) throw new Error(`Perfil não encontrado: ${id}`);
  await writeProfiles(next);
}

/** Usado pelo agendador logo após rodar um perfil — não passa pelo validate (só o timestamp muda). */
export async function markFollowUpProfileRan(id: string, ranAt: string): Promise<void> {
  const profiles = await readProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  const existing = profiles[idx];
  if (idx === -1 || !existing) return;
  const updated: FollowUpProfile = { ...existing, lastRunAt: ranAt };
  profiles[idx] = updated;
  await writeProfiles(profiles);
}
