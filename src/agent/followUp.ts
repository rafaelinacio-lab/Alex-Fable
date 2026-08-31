/**
 * Motor da automação de cobrança de chamados aguardando retorno/validação do cliente.
 *
 * Roda por PERFIL (src/config/followUpProfiles.ts) — cada perfil é uma equipe com sua
 * própria regra de SLA (janela de expediente, prazo, status monitorados, remetente).
 * Isso existe porque, além da equipe "Sistemas Internos" original, o usuário pediu para
 * poder configurar outras equipes com SLAs diferentes pelo painel, sem mexer em código.
 *
 * Regra (confirmada com o usuário), dentro de CADA perfil:
 *  1. o chamado é da equipe (`ownerTeam`) daquele perfil — filtrado no servidor E de
 *     novo localmente (defesa em profundidade, mesmo padrão de only_open).
 *  2. status do chamado é um dos monitorados pelo perfil (ex: "Aguardando Retorno do
 *     Cliente" / "Aguardando Validação do Cliente").
 *  3. a ÚLTIMA ação do chamado foi feita pelo OWNER (responsável) — se foi o cliente ou
 *     qualquer outra pessoa, o chamado não entra (o cliente já pode ter respondido e o
 *     status só não foi atualizado ainda).
 *  4. o tempo decorrido desde a referência (a mais recente entre a data da última ação
 *     do owner e a data em que o chamado entrou no status atual), contado em HORAS
 *     ÚTEIS pela janela de expediente DESTE perfil (não a de outro perfil, nem uma
 *     global fixa — src/movidesk/businessHours.ts), é >= ao limite configurado nele.
 *
 * Cada chamado que bate as quatro condições recebe uma ação pública automática (ver
 * buildFollowUpMessage), criada pela identidade dedicada configurada NO PERFIL — nunca
 * pelo owner do chamado. Cada mutação é auditada (store/audit.ts) e emitida como evento
 * para o painel poder mostrar o resultado sem o usuário precisar perguntar (ver
 * src/observability/eventBus.ts).
 */

import {
  searchTicketsExhaustive,
  patchTicket,
  type TicketSummary,
  type TicketActionSummary,
  type TicketStatusHistoryEntry,
} from "../movidesk/tickets.js";
import { businessMinutesElapsed, businessDaysToMinutes } from "../movidesk/businessHours.js";
import { buildFollowUpMessage, isFollowUpAutomationEnabled } from "../config/followUp.js";
import { listFollowUpProfiles, markFollowUpProfileRan, type FollowUpProfile } from "../config/followUpProfiles.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { emitEvent, newEventId } from "../observability/eventBus.js";
import { MovideskApiError } from "../movidesk/client.js";

const SYSTEM_ACTOR = { id_local: "sistema-followup", email: "automacao-followup@viasoft.com.br" };

export interface FollowUpTicketResult {
  id: number;
  subject: string;
  status: string;
  elapsedBusinessHours: number;
  action:
    | "charged"
    | "skipped_owner_not_last"
    | "skipped_within_threshold"
    | "skipped_no_data"
    | "skipped_wrong_team"
    | "error";
  errorMessage?: string;
}

export interface FollowUpRunResult {
  profileId: string;
  profileName: string;
  ownerTeam: string;
  checkedCount: number;
  charged: FollowUpTicketResult[];
  skipped: FollowUpTicketResult[];
  errors: FollowUpTicketResult[];
  ranAt: string;
}

function latestByDate<T extends { createdDate?: string } | { changedDate?: string }>(
  items: T[] | undefined,
  dateField: "createdDate" | "changedDate",
): T | undefined {
  if (!items?.length) return undefined;
  return items.reduce((latest, item) => {
    const itemDate = (item as Record<string, unknown>)[dateField] as string | undefined;
    const latestDate = (latest as Record<string, unknown>)[dateField] as string | undefined;
    if (!itemDate) return latest;
    if (!latestDate) return item;
    return new Date(itemDate) > new Date(latestDate) ? item : latest;
  });
}

/** Avalia um único ticket (já com actions/statusHistories expandidos) contra a regra de UM perfil. */
export function evaluateTicket(
  ticket: TicketSummary,
  profile: Pick<FollowUpProfile, "ownerTeam" | "thresholdBusinessDays" | "schedule">,
  now: Date = new Date(),
): FollowUpTicketResult {
  const base = { id: ticket.id, subject: ticket.subject, status: ticket.status };

  // Segunda verificação, além do $filter no servidor (defesa em profundidade — mesmo
  // padrão já usado para "em aberto": nunca confiar só no OData para restringir escopo
  // de uma mutação automática).
  if (ticket.ownerTeam !== profile.ownerTeam) {
    return { ...base, elapsedBusinessHours: 0, action: "skipped_wrong_team" };
  }

  if (!ticket.owner?.id) {
    return { ...base, elapsedBusinessHours: 0, action: "skipped_no_data" };
  }

  const lastAction = latestByDate<TicketActionSummary>(ticket.actions, "createdDate");
  if (!lastAction?.createdDate || !lastAction.createdBy?.id) {
    return { ...base, elapsedBusinessHours: 0, action: "skipped_no_data" };
  }

  if (lastAction.createdBy.id !== ticket.owner.id) {
    return { ...base, elapsedBusinessHours: 0, action: "skipped_owner_not_last" };
  }

  // Entre as entradas de statusHistories que batem o status ATUAL do ticket, pega a mais
  // recente — representa quando o chamado entrou na permanência atual nesse status.
  const matchingStatusEntries = (ticket.statusHistories ?? []).filter((h) => h.status === ticket.status);
  const statusEntry = latestByDate<TicketStatusHistoryEntry>(matchingStatusEntries, "changedDate");

  const actionDate = new Date(lastAction.createdDate);
  const statusDate = statusEntry?.changedDate ? new Date(statusEntry.changedDate) : undefined;
  const reference = statusDate && statusDate > actionDate ? statusDate : actionDate;

  const elapsedMinutes = businessMinutesElapsed(reference, now, { schedule: profile.schedule });
  const thresholdMinutes = businessDaysToMinutes(profile.thresholdBusinessDays, profile.schedule);
  const elapsedBusinessHours = Math.round((elapsedMinutes / 60) * 10) / 10;

  if (elapsedMinutes < thresholdMinutes) {
    return { ...base, elapsedBusinessHours, action: "skipped_within_threshold" };
  }

  return { ...base, elapsedBusinessHours, action: "charged" };
}

async function chargeTicket(
  result: FollowUpTicketResult,
  profile: Pick<FollowUpProfile, "reminderSenderId">,
): Promise<FollowUpTicketResult> {
  const payload = {
    actions: [
      {
        type: 2, // pública — precisa chegar ao cliente
        createdBy: { id: profile.reminderSenderId },
        description: buildFollowUpMessage(result.subject),
      },
    ],
  };
  try {
    await patchTicket(result.id, payload);
    await recordAuditEvent({
      timestamp: new Date().toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "cobrança automática de retorno do cliente",
      operation: "followUp.chargeTicket",
      endpoint: "PATCH /tickets",
      targetId: result.id,
      payloadHash: hashPayload(payload),
      correlationId: newCorrelationId(),
      httpStatus: 200,
      changedFields: ["actions"],
    });
    return result;
  } catch (err) {
    const errorCode = err instanceof MovideskApiError ? `movidesk:${err.status}:${err.propertyName ?? ""}` : "unknown";
    await recordAuditEvent({
      timestamp: new Date().toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "cobrança automática de retorno do cliente",
      operation: "followUp.chargeTicket",
      endpoint: "PATCH /tickets",
      targetId: result.id,
      payloadHash: hashPayload(payload),
      correlationId: newCorrelationId(),
      errorCode,
    });
    return { ...result, action: "error", errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Roda a verificação completa de UM perfil: busca os chamados da equipe/status dele,
 * avalia a regra ticket a ticket, cobra os que qualificam, e devolve um resumo. Não
 * lança em caso de falha pontual num ticket — cada erro fica registrado em `errors`.
 */
export async function runFollowUpCheck(profile: FollowUpProfile): Promise<FollowUpRunResult> {
  const now = new Date();
  const allTickets: TicketSummary[] = [];
  const seenIds = new Set<number>();

  // Duas buscas separadas (uma por status) em vez de um único filtro com "or" — "or" não
  // é operador confirmado nesta API (ver docs/movidesk-api-tickets.md, seção 6). O filtro
  // por ownerTeam (via "and", operador confirmado) restringe a busca à equipe do perfil.
  const teamFilter = `ownerTeam eq '${profile.ownerTeam.replace(/'/g, "''")}'`;
  for (const status of profile.waitingStatuses) {
    const result = await searchTicketsExhaustive({
      filter: `status eq '${status.replace(/'/g, "''")}' and ${teamFilter}`,
      select: ["id", "subject", "status", "owner", "ownerTeam"],
      expand: "actions,statusHistories",
    });
    for (const ticket of result.tickets) {
      if (!seenIds.has(ticket.id)) {
        seenIds.add(ticket.id);
        allTickets.push(ticket);
      }
    }
  }

  const charged: FollowUpTicketResult[] = [];
  const skipped: FollowUpTicketResult[] = [];
  const errors: FollowUpTicketResult[] = [];

  for (const ticket of allTickets) {
    const evaluation = evaluateTicket(ticket, profile, now);
    if (evaluation.action === "charged") {
      const chargeResult = await chargeTicket(evaluation, profile);
      (chargeResult.action === "charged" ? charged : errors).push(chargeResult);
    } else {
      skipped.push(evaluation);
    }
  }

  const runResult: FollowUpRunResult = {
    profileId: profile.id,
    profileName: profile.name,
    ownerTeam: profile.ownerTeam,
    checkedCount: allTickets.length,
    charged,
    skipped,
    errors,
    ranAt: now.toISOString(),
  };

  await markFollowUpProfileRan(profile.id, runResult.ranAt);

  emitEvent({
    kind: "tool_call_end",
    id: newEventId(),
    timestamp: now.toISOString(),
    tool: `followUp.runFollowUpCheck[${profile.name}]`,
    status: errors.length > 0 ? "error" : "ok",
    durationMs: 0,
    output: {
      profileId: profile.id,
      ownerTeam: profile.ownerTeam,
      checkedCount: runResult.checkedCount,
      chargedIds: charged.map((c) => c.id),
      errorIds: errors.map((e) => e.id),
    },
  });

  return runResult;
}

/**
 * Roda a verificação para TODOS os perfis com `enabled: true`, respeitando o gate
 * global `FOLLOWUP_AUTOMATION_ENABLED` (se desligado, não busca nada e devolve []).
 */
export async function runAllFollowUpChecks(): Promise<FollowUpRunResult[]> {
  if (!isFollowUpAutomationEnabled()) return [];
  const profiles = await listFollowUpProfiles();
  const results: FollowUpRunResult[] = [];
  for (const profile of profiles.filter((p) => p.enabled)) {
    results.push(await runFollowUpCheck(profile));
  }
  return results;
}
