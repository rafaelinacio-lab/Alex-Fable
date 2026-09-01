/**
 * Motor da automação de cobrança E fechamento de chamados aguardando retorno/validação
 * do cliente.
 *
 * Roda por PERFIL (src/config/followUpProfiles.ts) — cada perfil é um ESCOPO (uma equipe
 * inteira, ou um owner/responsável específico — `scopeType`) com sua própria regra de
 * SLA (janela de expediente, prazos, status monitorados, remetente). Isso existe porque,
 * além da equipe "Sistemas Internos" original, o usuário pediu para poder configurar
 * outras equipes (ou pessoas específicas) com SLAs diferentes pelo painel, sem mexer em
 * código.
 *
 * Regra (confirmada com o usuário), dentro de CADA perfil, UMA ÚNICA passada por chamado
 * decide entre cobrar, fechar ou não fazer nada:
 *  1. o chamado está dentro do escopo do perfil — `scopeType: "team"` restringe por
 *     `ownerTeam`, `scopeType: "owner"` por `owner.id` do chamado; ambos filtrados no
 *     servidor E de novo localmente (defesa em profundidade, mesmo padrão de only_open —
 *     ver nota em followUpProfiles.ts sobre `owner/id eq '...'` ter sido confirmado ao
 *     vivo, apesar de não documentado publicamente).
 *  2. status do chamado é um dos monitorados pelo perfil, E — se o perfil configurar
 *     `waitingJustifications` — o `justification` do chamado também bate. Em vários
 *     tenants (confirmado em produção real) o `status` é genérico (ex: "Aguardando") e
 *     é o `justification` que diz a razão específica (ex: "Validação Cliente", "Retorno
 *     Cliente") — sem checar `justification` também, o filtro nunca encontra nada
 *     nesses tenants (bug real já visto: perfil configurado com
 *     status:["Aguardando Retorno do Cliente", ...] sempre retornava zero, porque esse
 *     texto nunca existe como `status` — a distinção real estava no `justification`).
 *  3. a ÚLTIMA ação REAL do chamado foi feita pelo OWNER (responsável) — "real" exclui
 *     ações do próprio `reminderSenderId` da automação (ex: Alex Fable): uma cobrança
 *     anterior não conta como resposta de ninguém, senão o chamado ficaria marcado como
 *     "cliente respondeu" para sempre depois da primeira cobrança. Se a última ação real
 *     foi do cliente ou de qualquer outra pessoa, o chamado não entra.
 *  4. o tempo decorrido desde a referência (a mais recente entre a data dessa última
 *     ação real do owner e a data em que o chamado entrou no status/justification
 *     atual), contado em HORAS ÚTEIS pela janela de expediente DESTE perfil (não a de
 *     outro perfil, nem uma global fixa — src/movidesk/businessHours.ts), decide o quê:
 *       - se `autoCloseEnabled` estiver ligado (perfil E gate global) e o tempo já
 *         passou de `autoCloseThresholdBusinessDays` (regra de SLA confirmada com o
 *         usuário, 2026-09-01: "3 dias úteis desde a última ação do owner", direto —
 *         NÃO depende de o chamado já ter sido cobrado antes) -> FECHA (status
 *         "Resolvido" + ação pública explicando). Fechar tem prioridade sobre cobrar.
 *       - senão, se já passou de `thresholdBusinessHours` (24h úteis por padrão) -> COBRA
 *         (ação pública pedindo retorno).
 *       - senão, ainda dentro do prazo -> não faz nada.
 *
 * Cada mutação é auditada (store/audit.ts) e emitida como evento para o painel poder
 * mostrar o resultado sem o usuário precisar perguntar (src/observability/eventBus.ts).
 */

import {
  searchTicketsExhaustive,
  patchTicket,
  type TicketSummary,
  type TicketActionSummary,
  type TicketStatusHistoryEntry,
} from "../movidesk/tickets.js";
import { businessMinutesElapsed, businessDaysToMinutes } from "../movidesk/businessHours.js";
import {
  buildFollowUpMessage,
  buildAutoCloseMessage,
  isFollowUpAutomationEnabled,
  isFollowUpAutoCloseEnabled,
} from "../config/followUp.js";
import { listFollowUpProfiles, markFollowUpProfileRan, type FollowUpProfile } from "../config/followUpProfiles.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { recordCharge, updateChargeStatus } from "../store/followUpCharges.js";
import { recordChargeRun } from "../store/followUpRunLog.js";
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
    | "should_close" // decisão pura de evaluateTicket — vira "closed"/"error" depois de closeTicket rodar
    | "closed"
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
  closed: FollowUpTicketResult[];
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
    | "scopeType"
    | "ownerTeam"
    | "ownerId"
    | "waitingJustifications"
    | "thresholdBusinessHours"
    | "autoCloseEnabled"
    | "autoCloseThresholdBusinessDays"
    | "schedule"
    | "reminderSenderId"
  >,
  now: Date = new Date(),
): FollowUpTicketResult {
  const base = { id: ticket.id, subject: ticket.subject, status: ticket.status };

  // Ações do PRÓPRIO remetente da automação (reminderSenderId, ex: Alex Fable) não contam
  // como "alguém respondeu" nem servem de referência de tempo — é o nosso próprio
  // lembrete, não uma resposta real de owner/cliente. Sem filtrar isso, depois da
  // primeira cobrança a última ação do ticket passa a ser sempre da automação, e o
  // ticket fica rotulado como "cliente respondeu" (skipped_owner_not_last) para sempre,
  // mesmo que ninguém tenha respondido de verdade.
  const realActions = (ticket.actions ?? []).filter((a) => a.createdBy?.id !== profile.reminderSenderId);
  const lastAction = latestByDate<TicketActionSummary>(realActions, "createdDate");

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

  const actionDate = lastAction?.createdDate ? new Date(lastAction.createdDate) : undefined;
  const statusDate = statusEntry?.changedDate ? new Date(statusEntry.changedDate) : undefined;
  const reference =
    actionDate && statusDate ? (statusDate > actionDate ? statusDate : actionDate) : (actionDate ?? statusDate);

  // Calculado ANTES dos filtros de escopo/justification/owner (abaixo) — dá pra mostrar
  // "há quanto tempo esse chamado está parado" mesmo quando ele acaba sendo pulado por
  // outro motivo (equipe errada, justification não monitorada etc.), em vez de sempre 0h.
  const elapsedMinutes = reference ? businessMinutesElapsed(reference, now, { schedule: profile.schedule }) : 0;
  // Horas úteis -> minutos é só *60 (não precisa da janela de expediente para essa
  // conversão — diferente de "dias úteis", que dependia do tamanho do expediente).
  const thresholdMinutes = profile.thresholdBusinessHours * 60;
  const elapsedBusinessHours = Math.round((elapsedMinutes / 60) * 10) / 10;

  // Filtro de escopo — SEGUNDA verificação além do $filter no servidor (tanto "team"
  // quanto "owner" já filtram lá, ver runFollowUpCheck), defesa em profundidade: mesmo
  // padrão já usado para "em aberto", nunca confiar só no OData para restringir o escopo
  // de uma mutação automática.
  if (profile.scopeType === "team") {
    if (ticket.ownerTeam !== profile.ownerTeam) {
      return { ...base, elapsedBusinessHours, action: "skipped_wrong_team" };
    }
  } else {
    if (ticket.owner?.id !== profile.ownerId) {
      return { ...base, elapsedBusinessHours, action: "skipped_wrong_owner" };
    }
  }

  // Filtro por justification (opcional) — só local, nunca via $filter (ver nota no topo
  // do arquivo e em followUpProfiles.ts sobre não montar "or" no OData).
  if (profile.waitingJustifications?.length && !profile.waitingJustifications.includes(ticket.justification ?? "")) {
    return { ...base, elapsedBusinessHours, action: "skipped_wrong_justification" };
  }

  if (!ticket.owner?.id) {
    return { ...base, elapsedBusinessHours, action: "skipped_no_data" };
  }

  if (!lastAction?.createdDate || !lastAction.createdBy?.id) {
    return { ...base, elapsedBusinessHours, action: "skipped_no_data" };
  }

  if (lastAction.createdBy.id !== ticket.owner.id) {
    return { ...base, elapsedBusinessHours, action: "skipped_owner_not_last" };
  }

  // Fechar tem PRIORIDADE sobre cobrar — se o prazo de fechamento (mais longo) já venceu,
  // não faz sentido mandar uma cobrança antes. Independe de o chamado já ter sido cobrado
  // alguma vez (regra confirmada com o usuário, 2026-09-01: conta direto da última ação
  // real do owner, não de uma cobrança anterior).
  if (profile.autoCloseEnabled) {
    const closeThresholdMinutes = businessDaysToMinutes(profile.autoCloseThresholdBusinessDays, profile.schedule);
    if (elapsedMinutes >= closeThresholdMinutes) {
      return { ...base, elapsedBusinessHours, action: "should_close" };
    }
  }

  if (elapsedMinutes < thresholdMinutes) {
    return { ...base, elapsedBusinessHours, action: "skipped_within_threshold" };
  }

  return { ...base, elapsedBusinessHours, action: "charged" };
}

async function chargeTicket(
  ticket: TicketSummary,
  result: FollowUpTicketResult,
  profile: Pick<FollowUpProfile, "id" | "name" | "reminderSenderId" | "thresholdBusinessHours" | "schedule">,
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
    // Rastreamento para o painel (aba "Cobranças") e para o fechamento automático saber
    // quando o prazo começou a contar — ver src/store/followUpCharges.ts. Isolado num
    // try/catch próprio: uma falha AQUI não pode fazer a cobrança (que já foi enviada de
    // verdade ao cliente, GET/PATCH acima já teve sucesso) aparecer como erro — mesma
    // lição do bug de corpo vazio em client.ts (nunca reportar sucesso real como falha).
    try {
      await recordCharge({
        ticketId: result.id,
        profileId: profile.id,
        profileName: profile.name,
        subject: result.subject,
        ownerTeam: ticket.ownerTeam,
        ownerId: ticket.owner?.id,
        chargedAt: new Date().toISOString(),
        thresholdBusinessHours: profile.thresholdBusinessHours,
        schedule: profile.schedule,
        reminderSenderId: profile.reminderSenderId,
      });
    } catch (trackErr) {
      console.error(
        `followUp: falha ao registrar rastreamento da cobrança do #${result.id} (a cobrança em si foi enviada normalmente):`,
        trackErr,
      );
    }
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
 * Fecha (status "Resolvido") um chamado cujo owner está em silêncio há mais tempo que
 * `autoCloseThresholdBusinessDays` — decidido por `evaluateTicket` (action "should_close").
 * Mesma identidade dedicada do perfil que cobra (nunca o owner individual).
 */
async function closeTicket(
  result: FollowUpTicketResult,
  profile: Pick<FollowUpProfile, "reminderSenderId">,
): Promise<FollowUpTicketResult> {
  const payload = {
    status: "Resolvido",
    justification: null,
    actions: [
      {
        type: 2, // pública — precisa chegar ao cliente
        createdBy: { id: profile.reminderSenderId },
        description: buildAutoCloseMessage(result.subject),
      },
    ],
  };
  try {
    await patchTicket(result.id, payload);
    await recordAuditEvent({
      timestamp: new Date().toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "fechamento automático por falta de retorno do owner (regra de SLA)",
      operation: "followUp.closeTicket",
      endpoint: "PATCH /tickets",
      targetId: result.id,
      payloadHash: hashPayload(payload),
      correlationId: newCorrelationId(),
      httpStatus: 200,
      changedFields: ["status", "justification", "actions"],
    });
    // Se esse chamado tinha uma cobrança rastreada pendente (store/followUpCharges.ts),
    // marca como encerrada — evita a aba "Cobranças" mostrar um chamado já fechado como
    // se ainda estivesse esperando resposta. No-op silencioso se não havia rastreamento
    // (chamado fechado direto, sem cobrança prévia — a regra não exige uma). Isolado do
    // resultado real: mesma lição do bug de corpo vazio em client.ts.
    try {
      await updateChargeStatus(result.id, { status: "closed", resolvedAt: new Date().toISOString() });
    } catch (trackErr) {
      console.error(`followUp: falha ao atualizar rastreamento de cobrança do #${result.id} após fechamento:`, trackErr);
    }
    return { ...result, action: "closed" };
  } catch (err) {
    const errorCode = err instanceof MovideskApiError ? `movidesk:${err.status}:${err.propertyName ?? ""}` : "unknown";
    await recordAuditEvent({
      timestamp: new Date().toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "fechamento automático por falta de retorno do owner (regra de SLA)",
      operation: "followUp.closeTicket",
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
  // "team" acrescenta o filtro por ownerTeam; escopo "owner" acrescenta por owner/id —
  // ambos via "and" direto na busca (confirmado ao vivo, docs/movidesk-api-tickets.md
  // seção 6.7: `owner/id eq '...'` funciona, embora não fosse documentado publicamente;
  // `owner.id`/`ownerId` foram testados e devolvem 400). Mesmo com o filtro no servidor,
  // evaluateTicket confere de novo localmente (defesa em profundidade, mesmo padrão do
  // "em aberto") — nunca confiar só no $filter para restringir o escopo de uma mutação
  // automática.
  const scopeFilter =
    profile.scopeType === "team"
      ? ` and ownerTeam eq '${(profile.ownerTeam ?? "").replace(/'/g, "''")}'`
      : ` and owner/id eq '${(profile.ownerId ?? "").replace(/'/g, "''")}'`;
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
      //
      // MESMO PROBLEMA, um nível mais fundo: `actions` sem sub-expand devolve cada ação
      // SEM `createdBy` (confirmado ao vivo) — e é `lastAction.createdBy.id` que decide
      // se a última ação foi do owner (regra 3 do topo do arquivo). Sem
      // `actions($expand=createdBy)`, toda ação vinha com createdBy ausente e TODO
      // ticket caía em skipped_no_data, mesmo já com owner/status/justification certos.
      // Sintaxe de sub-expand confirmada em docs/movidesk-api-tickets.md seção 6.5
      // (`actions($expand=timeAppointments($expand=createdBy))`) — mesma ideia, um nível
      // menos aninhado.
      expand: "actions($expand=createdBy),statusHistories,owner",
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
  const closed: FollowUpTicketResult[] = [];
  const skipped: FollowUpTicketResult[] = [];
  const errors: FollowUpTicketResult[] = [];

  // O gate global de fechamento (env) só é lido AQUI (não dentro de evaluateTicket, que é
  // uma função pura sem I/O nem leitura de env — mesmo princípio do gate de cobrança em
  // isFollowUpAutomationEnabled). Combinado com o `autoCloseEnabled` do próprio perfil:
  // os dois precisam estar ligados para o perfil fechar chamados sozinho.
  const evalProfile = { ...profile, autoCloseEnabled: profile.autoCloseEnabled && isFollowUpAutoCloseEnabled() };

  for (const ticket of allTickets) {
    const evaluation = evaluateTicket(ticket, evalProfile, now);
    if (evaluation.action === "should_close") {
      const closeResult = await closeTicket(evaluation, profile);
      (closeResult.action === "closed" ? closed : errors).push(closeResult);
    } else if (evaluation.action === "charged") {
      const chargeResult = await chargeTicket(ticket, evaluation, profile);
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
    closed,
    skipped,
    errors,
    ranAt: now.toISOString(),
    diagnostics,
  };

  await markFollowUpProfileRan(profile.id, runResult.ranAt);

  // "Última verificação" para o painel (aba Cobranças) — mostra TODO chamado examinado
  // nesta rodada, não só os cobrados (skipped_within_threshold, skipped_wrong_justification
  // etc. também aparecem, com o motivo). Isolado do resto: uma falha aqui não deve
  // esconder o resultado real da rodada do usuário nem contar como erro da automação.
  try {
    await recordChargeRun({
      profileId: profile.id,
      profileName: profile.name,
      scopeLabel,
      ranAt: runResult.ranAt,
      checkedCount: runResult.checkedCount,
      thresholdBusinessHours: profile.thresholdBusinessHours,
      autoCloseEnabled: evalProfile.autoCloseEnabled,
      autoCloseThresholdHours:
        businessDaysToMinutes(profile.autoCloseThresholdBusinessDays, profile.schedule) / 60,
      tickets: [...charged, ...closed, ...skipped, ...errors].map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        elapsedBusinessHours: t.elapsedBusinessHours,
        action: t.action,
        errorMessage: t.errorMessage,
      })),
    });
  } catch (err) {
    console.error("followUp: falha ao registrar log da última verificação (não afeta a rodada em si):", err);
  }

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
      closedIds: closed.map((c) => c.id),
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
