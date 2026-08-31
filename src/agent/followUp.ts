/**
 * Motor da automação de cobrança de chamados aguardando retorno/validação do cliente.
 *
 * Roda por PERFIL (src/config/followUpProfiles.ts) — cada perfil é um ESCOPO (uma equipe
 * inteira, ou um owner/responsável específico — `scopeType`) com sua própria regra de
 * SLA (janela de expediente, prazo, status monitorados, remetente). Isso existe porque,
 * além da equipe "Sistemas Internos" original, o usuário pediu para poder configurar
 * outras equipes (ou pessoas específicas) com SLAs diferentes pelo painel, sem mexer em
 * código.
 *
 * Regra (confirmada com o usuário), dentro de CADA perfil:
 *  1. o chamado está dentro do escopo do perfil — `scopeType: "team"` restringe por
 *     `ownerTeam` (filtrado no servidor E de novo localmente, defesa em profundidade,
 *     mesmo padrão de only_open); `scopeType: "owner"` restringe pelo `owner.id` do
 *     chamado, filtrado só localmente (ver nota em followUpProfiles.ts sobre não
 *     inventar filtro OData por propriedade de navegação singular não confirmada).
 *  2. status do chamado é um dos monitorados pelo perfil, E — se o perfil configurar
 *     `waitingJustifications` — o `justification` do chamado também bate. Em vários
 *     tenants (confirmado em produção real) o `status` é genérico (ex: "Aguardando") e
 *     é o `justification` que diz a razão específica (ex: "Validação Cliente", "Retorno
 *     Cliente") — sem checar `justification` também, o filtro nunca encontra nada
 *     nesses tenants (bug real já visto: perfil configurado com
 *     status:["Aguardando Retorno do Cliente", ...] sempre retornava zero, porque esse
 *     texto nunca existe como `status` — a distinção real estava no `justification`).
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
    | "skipped_wrong_owner"
    | "skipped_wrong_justification"
    | "error";
  errorMessage?: string;
}

export interface FollowUpRunResult {
  profileId: string;
  profileName: string;
  /** Descrição legível do escopo (equipe ou owner) — para exibição (chat/logs). */
  scopeLabel: string;
  checkedCount: number;
  charged: FollowUpTicketResult[];
  skipped: FollowUpTicketResult[];
  errors: FollowUpTicketResult[];
  ranAt: string;
  /**
   * Preenchido só quando checkedCount === 0 — ajuda a distinguir "não existe mesmo
   * nenhum chamado nessa situação" de "o texto do status/equipe configurado no perfil
   * não bate com o valor real" (causa mais comum de zero resultados inesperado).
   */
  diagnostics?: string[];
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
  profile: Pick<
    FollowUpProfile,
    "scopeType" | "ownerTeam" | "ownerId" | "waitingJustifications" | "thresholdBusinessDays" | "schedule"
  >,
  now: Date = new Date(),
): FollowUpTicketResult {
  const base = { id: ticket.id, subject: ticket.subject, status: ticket.status };

  // Filtro de escopo. Para "team", é uma SEGUNDA verificação além do $filter no servidor
  // (defesa em profundidade — mesmo padrão já usado para "em aberto": nunca confiar só
  // no OData para restringir escopo de uma mutação automática). Para "owner", é a ÚNICA
  // camada de filtro (não há $filter de servidor para isso — ver followUpProfiles.ts).
  if (profile.scopeType === "team") {
    if (ticket.ownerTeam !== profile.ownerTeam) {
      return { ...base, elapsedBusinessHours: 0, action: "skipped_wrong_team" };
    }
  } else {
    if (ticket.owner?.id !== profile.ownerId) {
      return { ...base, elapsedBusinessHours: 0, action: "skipped_wrong_owner" };
    }
  }

  // Filtro por justification (opcional) — só local, nunca via $filter (ver nota no topo
  // do arquivo e em followUpProfiles.ts sobre não montar "or" no OData).
  if (profile.waitingJustifications?.length && !profile.waitingJustifications.includes(ticket.justification ?? "")) {
    return { ...base, elapsedBusinessHours: 0, action: "skipped_wrong_justification" };
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

  // Entre as entradas de statusHistories que batem o status (E o justification, quando
  // presente) ATUAIS do ticket, pega a mais recente — representa quando o chamado entrou
  // na permanência atual nessa combinação. Comparar só por status seria impreciso em
  // tenants onde o mesmo status genérico (ex: "Aguardando") é reusado para razões
  // diferentes (justification) — pegaria a data errada se o chamado já passou por lá
  // antes por outro motivo.
  const matchingStatusEntries = (ticket.statusHistories ?? []).filter(
    (h) => h.status === ticket.status && (!ticket.justification || h.justification === ticket.justification),
  );
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

/** Descrição legível do escopo de um perfil, para exibição (chat/logs/painel). */
export function describeScope(profile: Pick<FollowUpProfile, "scopeType" | "ownerTeam" | "ownerId" | "ownerName">): string {
  if (profile.scopeType === "team") return profile.ownerTeam ?? "(equipe não definida)";
  return profile.ownerName ? `${profile.ownerName} (${profile.ownerId})` : `owner ${profile.ownerId}`;
}

/**
 * Quando uma verificação não encontra NENHUM chamado, a causa mais comum não é "não
 * existe mesmo nenhum chamado nessa situação" — é o texto de `status` ou `ownerTeam`
 * configurado no perfil não bater EXATAMENTE (o `$filter` OData usa `eq`, sensível a
 * maiúsculas/minúsculas e espaços) com o valor real no Movidesk. Esta função roda
 * consultas extras (baratas — sem `expand`, com um teto de páginas pequeno) para
 * distinguir os dois casos e devolver uma dica acionável em vez de só "0 encontrados".
 */
async function diagnoseEmptyResult(profile: FollowUpProfile): Promise<string[]> {
  const notes: string[] = [];
  try {
    let totalByStatusOnly = 0;
    const teamsSeen = new Set<string>();
    for (const status of profile.waitingStatuses) {
      const result = await searchTicketsExhaustive(
        { filter: `status eq '${status.replace(/'/g, "''")}'`, select: ["id", "ownerTeam"] },
        { maxPages: 5 }, // até 500 registros — suficiente para diagnóstico, não precisa ser exaustivo
      );
      totalByStatusOnly += result.tickets.length;
      for (const t of result.tickets) {
        if (typeof t.ownerTeam === "string") teamsSeen.add(t.ownerTeam);
      }
    }

    if (totalByStatusOnly === 0) {
      notes.push(
        `Nenhum chamado encontrado com o(s) status monitorado(s) (${profile.waitingStatuses.map((s) => `"${s}"`).join(" ou ")}) em TODA a base, mesmo sem filtrar por ${profile.scopeType === "team" ? "equipe" : "owner"}. Confira se o texto do status bate EXATAMENTE (maiúsculas/minúsculas e espaços importam) com o status configurado no Movidesk — o filtro usa comparação exata (eq). ` +
          `Causa comum: neste tenant o campo "status" pode ser genérico (ex: "Aguardando") e a razão específica ("aguardando retorno" vs "aguardando validação") ficar no campo "justification" — busque um chamado real e confira; se for esse o caso, ajuste "Status monitorados" para o texto genérico e preencha "Justificativas monitoradas" com as razões exatas.`,
      );
    } else if (profile.scopeType === "team") {
      const sample = [...teamsSeen].slice(0, 8);
      notes.push(
        `Sem o filtro de equipe, existem ${totalByStatusOnly} chamado(s) com esse(s) status. ` +
          `Nenhum tinha ownerTeam exatamente igual a "${profile.ownerTeam}". ` +
          (sample.length
            ? `Equipes encontradas nesses chamados: ${sample.map((t) => `"${t}"`).join(", ")}. Confira se alguma bate com o texto configurado no perfil (comparação exata, sensível a maiúsculas/minúsculas e espaços).`
            : "Não foi possível amostrar o ownerTeam desses chamados."),
      );
    } else {
      notes.push(
        `Existem ${totalByStatusOnly} chamado(s) com esse(s) status na base, mas nenhum tem owner.id igual a "${profile.ownerId}". Confira se o cod_ref configurado no perfil é o do responsável correto.`,
      );
    }
  } catch (err) {
    notes.push(`Não foi possível rodar o diagnóstico automático: ${err instanceof Error ? err.message : String(err)}`);
  }
  return notes;
}

/**
 * Roda a verificação completa de UM perfil: busca os chamados do escopo/status dele,
 * avalia a regra ticket a ticket, cobra os que qualificam, e devolve um resumo. Não
 * lança em caso de falha pontual num ticket — cada erro fica registrado em `errors`.
 */
export async function runFollowUpCheck(profile: FollowUpProfile): Promise<FollowUpRunResult> {
  const now = new Date();
  const allTickets: TicketSummary[] = [];
  const seenIds = new Set<number>();

  // Duas buscas separadas (uma por status) em vez de um único filtro com "or" — "or" não
  // é operador confirmado nesta API (ver docs/movidesk-api-tickets.md, seção 6). Escopo
  // "team" acrescenta o filtro por ownerTeam (via "and", operador confirmado) direto na
  // busca; escopo "owner" não filtra no servidor (ver nota em followUpProfiles.ts) — o
  // filtro por owner.id acontece só em evaluateTicket, depois de buscar por status.
  const scopeFilter =
    profile.scopeType === "team" ? ` and ownerTeam eq '${(profile.ownerTeam ?? "").replace(/'/g, "''")}'` : "";
  for (const status of profile.waitingStatuses) {
    const result = await searchTicketsExhaustive({
      filter: `status eq '${status.replace(/'/g, "''")}'${scopeFilter}`,
      select: ["id", "subject", "status", "justification", "owner", "ownerTeam"],
      // IMPORTANTE: `owner` só vem preenchido no endpoint de LISTA (/tickets) se estiver
      // em $expand — diferente de GET /tickets?id=..., que sempre inclui o objeto
      // completo. Pedir só em $select (sem expand) devolve o ticket sem a propriedade
      // `owner` (não null — ausente), o que quebrava silenciosamente: evaluateTicket
      // usa ticket.owner.id tanto para o escopo "owner" (linha ~125) quanto para
      // decidir se a ÚLTIMA ação foi do responsável (linha ~145, todo perfil, mesmo
      // escopo "team") — sem isso, todo chamado caía em skipped_wrong_owner/
      // skipped_no_data e a automação nunca cobrava ninguém, em nenhum perfil.
      expand: "actions,statusHistories,owner",
    });
    for (const ticket of result.tickets) {
      if (!seenIds.has(ticket.id)) {
        seenIds.add(ticket.id);
        allTickets.push(ticket);
      }
    }
  }

  const diagnostics = allTickets.length === 0 ? await diagnoseEmptyResult(profile) : undefined;

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

  const scopeLabel = describeScope(profile);

  const runResult: FollowUpRunResult = {
    profileId: profile.id,
    profileName: profile.name,
    scopeLabel,
    checkedCount: allTickets.length,
    charged,
    skipped,
    errors,
    ranAt: now.toISOString(),
    diagnostics,
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
      scope: scopeLabel,
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
