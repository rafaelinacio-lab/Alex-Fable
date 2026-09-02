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
 * produção, mantendo esta mesma assinatura). Cada perfil é independente: escopo (uma
 * EQUIPE inteira, ou um OWNER/responsável específico — ver `scopeType`), status
 * monitorados, prazo em dias úteis, sua PRÓPRIA janela de expediente (schedule),
 * intervalo de verificação, remetente e se está ligado.
 *
 * Escopo por owner (em vez de equipe): pedido do usuário para poder cobrar os chamados
 * de UMA PESSOA específica, não só de uma equipe inteira. A doc pública só documenta
 * filtro por coleção (`clients/any(...)`), não por propriedade de navegação singular —
 * mas testamos `owner/id eq '<COD_REF>'` ao vivo (2026-08-31, tenant VIASOFT) e funciona
 * (docs/movidesk-api-tickets.md, seção 6.7; `owner.id`/`ownerId` foram testados e dão
 * 400 — só a sintaxe com barra é aceita). `runFollowUpCheck` usa esse filtro no servidor
 * (evita paginar a base inteira só para descartar quase tudo localmente — chegou a levar
 * ~15 páginas/minutos para achar ~10 chamados de um owner num tenant com 1400+ tickets
 * "Aguardando"), e `evaluateTicket` confere `owner.id` de novo localmente, mesmo padrão
 * de defesa em profundidade já usado para `ownerTeam`.
 *
 * O gate global `FOLLOWUP_AUTOMATION_ENABLED` (env) continua existindo como interruptor
 * geral — nenhum perfil roda se ele não for "true", mesmo que o perfil individual esteja
 * `enabled: true` no painel. É a camada de segurança que impede uma automação nova de
 * começar a falar com clientes reais sozinha só por já existir configurada.
 *
 * `waitingJustifications` (opcional): confirmado em produção real (tenant VIASOFT) que
 * `status` sozinho pode ser genérico (ex: "Aguardando", baseStatus "Stopped") e é o campo
 * `justification` que diz a razão específica (ex: "Validação Cliente", "Retorno
 * Cliente") — sem isso, filtrar só por texto de `status` nunca encontra nada nesses
 * tenants. Quando preenchido, um chamado só é considerado se `ticket.justification`
 * estiver nessa lista (filtro só local, em `evaluateTicket` — ver nota abaixo sobre não
 * inventar `or` no `$filter`); vazio/omitido = não filtra por justificativa (tenants
 * onde o `status` já é descritivo o bastante sozinho).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SLA_SCHEDULE, type BusinessSchedule } from "../movidesk/businessHours.js";

export type FollowUpScopeType = "team" | "owner";

export interface FollowUpProfile {
  id: string;
  /** Rótulo livre, só para exibição no painel (ex: "Sistemas Internos"). */
  name: string;
  /** "team" restringe por ownerTeam; "owner" restringe por um responsável específico. */
  scopeType: FollowUpScopeType;
  /** Obrigatório quando scopeType === "team". Equipe à qual este perfil se restringe. */
  ownerTeam?: string;
  /** Obrigatório quando scopeType === "owner". cod_ref (id) do responsável na Movidesk. */
  ownerId?: string;
  /** Só para exibição no painel quando scopeType === "owner" (nome do responsável). */
  ownerName?: string;
  enabled: boolean;
  waitingStatuses: string[];
  /** Ver nota no topo do arquivo — filtro adicional por `justification`, opcional. */
  waitingJustifications?: string[];
  /** Prazo de silêncio (do owner) em HORAS ÚTEIS — não dias, para poder expressar valores
   * exatos como 24 (confirmado com o usuário) em vez de uma aproximação em dias úteis
   * cheios (24h úteis não é um número redondo de dias úteis num expediente de 8h45). */
  thresholdBusinessHours: number;
  /** Fechar sozinho (status "Resolvido") um chamado, se o OWNER estiver em silêncio há
   * mais de `autoCloseThresholdBusinessDays` (regra confirmada com o usuário, 2026-09-01:
   * "3 dias úteis, de acordo com a regra de SLA" — contado DIRETO da última ação real do
   * owner até o momento da verificação, independente de já ter sido cobrado antes ou não;
   * numa mesma passada por chamado, fechar tem prioridade sobre cobrar — ver
   * evaluateTicket em src/agent/followUp.ts). Padrão false — é uma mutação mais sensível
   * que só cobrar (não dá pra desfazer com uma mensagem), então exige opt-in explícito
   * por perfil, ALÉM do gate global `FOLLOWUP_AUTOCLOSE_ENABLED` (ver
   * src/config/followUp.ts). */
  autoCloseEnabled: boolean;
  /** Em DIAS úteis (não horas, diferente de thresholdBusinessHours) — mesma unidade usada
   * na regra de SLA original do usuário ("3 dias úteis"). */
  autoCloseThresholdBusinessDays: number;
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
  | "name"
  | "scopeType"
  | "ownerTeam"
  | "ownerId"
  | "ownerName"
  | "enabled"
  | "waitingStatuses"
  | "waitingJustifications"
  | "thresholdBusinessHours"
  | "autoCloseEnabled"
  | "autoCloseThresholdBusinessDays"
  | "checkIntervalHours"
  | "reminderSenderId"
  | "reminderSenderName"
  | "schedule"
>;

const PROFILES_FILE = process.env.FOLLOWUP_PROFILES_FILE ?? "./data/local/followup_profiles.json";

// Valores confirmados em produção real (tenant VIASOFT, equipe Sistemas Internos, ver
// nota grande acima sobre `waitingJustifications`): o `status` do chamado é o texto
// genérico "Aguardando" — "Aguardando Retorno do Cliente"/"Aguardando Validação do
// Cliente" NUNCA existem como valor de `status` neste tenant, só como `justification`
// (com capitalização inconsistente entre os dois: "Retorno do cliente" vs "Validação
// Cliente" — confirmado via amostragem de tickets reais). Usar o texto composto antigo
// como `status` fazia o `$filter` (comparação exata, `eq`) nunca bater com nada — o
// perfil-semente ficava sempre com checkedCount 0, silenciosamente, sem nenhum erro.
const DEFAULT_WAITING_STATUSES = ["Aguardando"];
const DEFAULT_WAITING_JUSTIFICATIONS = ["Retorno do cliente", "Validação Cliente"];

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
    scopeType: "team",
    ownerTeam: process.env.FOLLOWUP_OWNER_TEAM ?? "VIASOFT - Sistemas Internos",
    enabled: true,
    waitingStatuses: DEFAULT_WAITING_STATUSES,
    waitingJustifications: DEFAULT_WAITING_JUSTIFICATIONS,
    // 24h úteis: regra confirmada com o usuário (2026-08-31) — cobra quando a última ação
    // foi do owner e nenhum cliente do ticket respondeu há mais de 24 HORAS ÚTEIS.
    thresholdBusinessHours: Number(process.env.FOLLOWUP_THRESHOLD_BUSINESS_HOURS ?? 24),
    // Seguro por padrão — fechar sozinho é opt-in explícito (painel + gate global), nunca
    // ligado automaticamente só por existir o perfil.
    autoCloseEnabled: false,
    // 3 dias úteis: regra de SLA confirmada com o usuário (2026-09-01).
    autoCloseThresholdBusinessDays: Number(process.env.FOLLOWUP_AUTOCLOSE_THRESHOLD_BUSINESS_DAYS ?? 3),
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
  if (input.scopeType === "team") {
    if (!input.ownerTeam?.trim()) throw new Error("ownerTeam (equipe) não pode ser vazio quando o escopo é por equipe.");
  } else if (input.scopeType === "owner") {
    if (!input.ownerId?.trim()) throw new Error("ownerId (cod_ref do responsável) não pode ser vazio quando o escopo é por owner.");
  } else {
    throw new Error(`scopeType inválido: ${String(input.scopeType)} (use "team" ou "owner").`);
  }
  if (!input.waitingStatuses.length) throw new Error("Informe ao menos um status monitorado.");
  if (input.thresholdBusinessHours <= 0) throw new Error("thresholdBusinessHours deve ser positivo.");
  if (input.autoCloseThresholdBusinessDays <= 0) throw new Error("autoCloseThresholdBusinessDays deve ser positivo.");
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
