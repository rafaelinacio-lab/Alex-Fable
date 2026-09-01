/**
 * Motor de FECHAMENTO automático de chamados já cobrados (ver src/agent/followUp.ts) que
 * ficaram sem retorno do cliente por tempo demais depois da cobrança.
 *
 * Regra (confirmada com o usuário, 2026-08-31), por CHAMADO já cobrado (rastreado em
 * src/store/followUpCharges.ts, status "pending"):
 *
 *  0. dois gates de segurança, independentes do de cobrar: `FOLLOWUP_AUTOCLOSE_ENABLED`
 *     (global, .env) E `profile.autoCloseEnabled` (por perfil, painel) — os dois
 *     precisam estar ligados. Fechar é mais sensível que só publicar uma mensagem (não
 *     dá pra desfazer com uma nova mensagem), então tem opt-in próprio; ligar a cobrança
 *     NUNCA liga o fechamento sozinho.
 *  1. o chamado ainda está "parado" esperando cliente (baseStatus "Stopped") — se alguém
 *     já mudou o status manualmente (resolveu, cancelou, reabriu para "Em atendimento"
 *     sem passar por uma action nova, etc.), o rastreamento é encerrado como
 *     "resolved_externally" e o chamado nunca é tocado por este motor.
 *  2. a ÚLTIMA ação do chamado ainda é da automação (reminderSenderId da cobrança) ou do
 *     próprio owner — ou seja, nenhum cliente (nem ninguém mais) respondeu desde a
 *     cobrança. Se a última ação for de outra pessoa, o rastreamento vira "responded" e
 *     o chamado nunca é fechado por este motor (ele volta ao ciclo normal de
 *     cobrança/avaliação, se ainda se qualificar).
 *  3. o tempo decorrido DESDE A COBRANÇA (não desde o silêncio original), em HORAS ÚTEIS
 *     pela janela de expediente do perfil NO MOMENTO da cobrança (snapshot — ver
 *     ChargeRecord), já passou do mesmo `thresholdBusinessHours` usado para cobrar.
 *
 * Quando os quatro batem, o chamado é fechado (`status: "Resolvido"`) com uma ação
 * pública explicando o motivo — a mesma identidade dedicada que cobrou (nunca o owner).
 */

import { getTicket, patchTicket, type TicketSummary, type TicketActionSummary, BASE_STATUS } from "../movidesk/tickets.js";
import { businessMinutesElapsed } from "../movidesk/businessHours.js";
import { isFollowUpAutoCloseEnabled, buildAutoCloseMessage } from "../config/followUp.js";
import { listFollowUpProfiles, type FollowUpProfile } from "../config/followUpProfiles.js";
import { listPendingCharges, updateChargeStatus, type ChargeRecord } from "../store/followUpCharges.js";
import { recordCloseRun } from "../store/followUpRunLog.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { emitEvent, newEventId } from "../observability/eventBus.js";
import { MovideskApiError } from "../movidesk/client.js";

const SYSTEM_ACTOR = { id_local: "sistema-followup-autoclose", email: "automacao-followup@viasoft.com.br" };

export interface AutoCloseTicketResult {
  ticketId: number;
  subject: string;
  action: "closed" | "responded" | "resolved_externally" | "within_threshold" | "orphan_profile" | "disabled" | "error";
  errorMessage?: string;
}

export interface AutoCloseRunResult {
  checkedCount: number;
  closed: AutoCloseTicketResult[];
  skipped: AutoCloseTicketResult[];
  errors: AutoCloseTicketResult[];
}

function latestAction(actions: TicketActionSummary[] | undefined): TicketActionSummary | undefined {
  if (!actions?.length) return undefined;
  return actions.reduce((latest, item) =>
    !latest.createdDate || (item.createdDate && item.createdDate > latest.createdDate) ? item : latest,
  );
}

export type AutoCloseDecision =
  | "disabled"
  | "resolved_externally"
  | "responded"
  | "within_threshold"
  | "should_close";

/**
 * Decisão PURA (sem rede/IO) — mesmo princípio de `evaluateTicket` em followUp.ts:
 * testável sem depender do Movidesk, com toda a lógica de negócio isolada da parte que
 * efetivamente fecha o chamado (`evaluateAndClose`, abaixo).
 */
export function decideAutoClose(
  ticket: Pick<TicketSummary, "baseStatus" | "actions">,
  record: Pick<ChargeRecord, "chargedAt" | "thresholdBusinessHours" | "schedule" | "reminderSenderId" | "ownerId">,
  profile: Pick<FollowUpProfile, "autoCloseEnabled">,
  now: Date,
): AutoCloseDecision {
  if (!profile.autoCloseEnabled) return "disabled";

  if (ticket.baseStatus !== BASE_STATUS.PARADO) return "resolved_externally";

  const lastAction = latestAction(ticket.actions);
  const lastActorId = lastAction?.createdBy?.id;
  const isStillOurTurn = lastActorId === record.reminderSenderId || lastActorId === record.ownerId;
  if (!isStillOurTurn) return "responded";

  const elapsedMinutes = businessMinutesElapsed(new Date(record.chargedAt), now, { schedule: record.schedule });
  const thresholdMinutes = record.thresholdBusinessHours * 60;
  if (elapsedMinutes < thresholdMinutes) return "within_threshold";

  return "should_close";
}

async function evaluateAndClose(
  record: ChargeRecord,
  profile: Pick<FollowUpProfile, "autoCloseEnabled">,
  now: Date,
): Promise<AutoCloseTicketResult> {
  if (!profile.autoCloseEnabled) {
    return { ticketId: record.ticketId, subject: record.subject, action: "disabled" };
  }

  let ticket: TicketSummary;
  try {
    // GET /tickets?id=... (rota de UM ticket) sempre devolve o objeto completo — owner,
    // actions com createdBy, statusHistories — sem precisar de $expand (diferente da
    // busca em lista, ver notas em followUp.ts). Mais simples e mais barato que reusar
    // searchTicketsExhaustive para um único chamado.
    ticket = await getTicket(record.ticketId);
  } catch (err) {
    return {
      ticketId: record.ticketId,
      subject: record.subject,
      action: "error",
      errorMessage: `Falha ao buscar chamado: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const decision = decideAutoClose(ticket, record, profile, now);

  if (decision === "resolved_externally") {
    await updateChargeStatus(record.ticketId, { status: "resolved_externally", resolvedAt: now.toISOString() });
    return { ticketId: record.ticketId, subject: record.subject, action: "resolved_externally" };
  }
  if (decision === "responded") {
    await updateChargeStatus(record.ticketId, { status: "responded", resolvedAt: now.toISOString() });
    return { ticketId: record.ticketId, subject: record.subject, action: "responded" };
  }
  if (decision === "within_threshold") {
    return { ticketId: record.ticketId, subject: record.subject, action: "within_threshold" };
  }

  const payload = {
    status: "Resolvido",
    justification: null,
    actions: [
      {
        type: 2, // pública — precisa chegar ao cliente
        createdBy: { id: record.reminderSenderId },
        description: buildAutoCloseMessage(record.subject),
      },
    ],
  };
  try {
    await patchTicket(record.ticketId, payload);
    await recordAuditEvent({
      timestamp: now.toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "fechamento automático por falta de retorno do cliente após cobrança",
      operation: "followUpClose.closeTicket",
      endpoint: "PATCH /tickets",
      targetId: record.ticketId,
      payloadHash: hashPayload(payload),
      correlationId: newCorrelationId(),
      httpStatus: 200,
      changedFields: ["status", "justification", "actions"],
    });
    await updateChargeStatus(record.ticketId, { status: "closed", resolvedAt: now.toISOString() });
    return { ticketId: record.ticketId, subject: record.subject, action: "closed" };
  } catch (err) {
    const errorCode = err instanceof MovideskApiError ? `movidesk:${err.status}:${err.propertyName ?? ""}` : "unknown";
    const errorMessage = err instanceof Error ? err.message : String(err);
    await recordAuditEvent({
      timestamp: now.toISOString(),
      authenticatedUser: SYSTEM_ACTOR,
      intent: "fechamento automático por falta de retorno do cliente após cobrança",
      operation: "followUpClose.closeTicket",
      endpoint: "PATCH /tickets",
      targetId: record.ticketId,
      payloadHash: hashPayload(payload),
      correlationId: newCorrelationId(),
      errorCode,
    });
    await updateChargeStatus(record.ticketId, { status: "closed_error", closeError: errorMessage });
    return { ticketId: record.ticketId, subject: record.subject, action: "error", errorMessage };
  }
}

/**
 * Roda a checagem de fechamento para TODOS os chamados "pending" rastreados, em TODOS os
 * perfis — respeitando o gate global E o `autoCloseEnabled` de cada perfil individual.
 * Chamados cujo perfil já foi apagado ficam como "orphan_profile" (nunca fechados
 * sozinhos, tracking preservado — o usuário pode limpar manualmente se quiser).
 */
export async function runAutoCloseCheck(): Promise<AutoCloseRunResult> {
  const closed: AutoCloseTicketResult[] = [];
  const skipped: AutoCloseTicketResult[] = [];
  const errors: AutoCloseTicketResult[] = [];

  if (!isFollowUpAutoCloseEnabled()) {
    return { checkedCount: 0, closed, skipped, errors };
  }

  const [pending, profiles] = await Promise.all([listPendingCharges(), listFollowUpProfiles()]);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const now = new Date();

  for (const record of pending) {
    const profile = profilesById.get(record.profileId);
    if (!profile) {
      skipped.push({ ticketId: record.ticketId, subject: record.subject, action: "orphan_profile" });
      continue;
    }
    const result = await evaluateAndClose(record, profile, now);
    if (result.action === "closed") closed.push(result);
    else if (result.action === "error") errors.push(result);
    else skipped.push(result);
  }

  // "Última verificação" para o painel — mesmo princípio de recordChargeRun em
  // followUp.ts: mostra TODO chamado cobrado que foi examinado nesta rodada, não só os
  // fechados (isolado do resultado real: uma falha aqui não deve mascarar nada).
  try {
    await recordCloseRun({
      ranAt: now.toISOString(),
      checkedCount: pending.length,
      tickets: [...closed, ...skipped, ...errors].map((t) => ({
        id: t.ticketId,
        subject: t.subject,
        action: t.action,
        errorMessage: t.errorMessage,
      })),
    });
  } catch (err) {
    console.error("followUpClose: falha ao registrar log da última verificação (não afeta a rodada em si):", err);
  }

  emitEvent({
    kind: "tool_call_end",
    id: newEventId(),
    timestamp: now.toISOString(),
    tool: "followUpClose.runAutoCloseCheck",
    status: errors.length > 0 ? "error" : "ok",
    durationMs: 0,
    output: {
      checkedCount: pending.length,
      closedIds: closed.map((c) => c.ticketId),
      errorIds: errors.map((e) => e.ticketId),
    },
  });

  return { checkedCount: pending.length, closed, skipped, errors };
}
