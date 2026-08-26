/**
 * Contrato de ferramentas (seção 4 do prompt de sistema).
 *
 * Este é o único ponto de contato entre o modelo (LLM) e o mundo real. Cada ferramenta:
 *  - tem um schema de entrada validado com zod (nunca confie em JSON solto do modelo);
 *  - nunca recebe nem devolve o token Movidesk ou qualquer segredo;
 *  - registra auditoria antes/depois quando é uma mutação;
 *  - usa idempotência para criações de ticket.
 *
 * Para adaptar a um orquestrador diferente (outro provedor de LLM), reaproveite
 * `TOOL_DESCRIPTIONS` e `dispatchTool` — só a camada de loop de conversa
 * (orchestrator.ts) muda.
 */

import { z } from "zod";
import { getFlowConfig, TENANT_FLOWS, type FlowName } from "../config/tenant.js";
import { findContactByEmail, listOrganizations } from "../local/contacts.js";
import { searchAdUsers } from "../local/directory.js";
import { getTicket, searchTickets, createTicket, patchTicket } from "../movidesk/tickets.js";
import { getPerson, searchPersons, searchOrganizationsByName } from "../movidesk/persons.js";
import { getService, searchServices } from "../movidesk/services.js";
import { odataEscape, MovideskApiError } from "../movidesk/client.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { idempotencyGet, idempotencyPut, idempotencyReserve } from "../store/idempotency.js";
import { emitEvent, newEventId, sanitizeForDashboard } from "../observability/eventBus.js";

export interface AgentContext {
  conversationId: string;
  authenticatedUser: { id_local: string; username: string; name: string; email: string };
}

const FLOW_NAMES = Object.keys(TENANT_FLOWS) as [FlowName, ...FlowName[]];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const schemas = {
  get_authenticated_user: z.object({}),
  find_movidesk_contact_by_email: z.object({ email: z.string().email() }),
  search_ad_users: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).default(10) }),
  list_customer_organizations: z.object({
    query: z.string().default(""),
    limit: z.number().int().positive().max(50).default(10),
  }),
  movidesk_search_organizations: z.object({
    query: z.string().min(1),
    top: z.number().int().positive().max(50).default(20),
  }),
  get_flow_config: z.object({ flow_name: z.enum(FLOW_NAMES) }),

  movidesk_get_ticket: z.object({
    id: z.number().int().positive(),
    select: z.array(z.string()).optional(),
    expand: z.string().optional(),
  }),
  movidesk_search_tickets: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
  movidesk_create_ticket: z.object({
    idempotency_key: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    return_all_properties: z.boolean().default(false),
  }),
  movidesk_patch_ticket: z.object({
    id: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()),
    intent: z.string().min(1), // usado só para auditoria
  }),
  movidesk_get_person: z.object({ id: z.string().min(1) }),
  movidesk_search_persons: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
  movidesk_get_service: z.object({ id: z.number().int().positive() }),
  movidesk_search_services: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
} as const;

export type ToolName = keyof typeof schemas;

// ---------------------------------------------------------------------------
// Descrições para o orquestrador (Claude tool-use)
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_authenticated_user: "Retorna o usuário autenticado na sessão atual (id_local, username, name, email).",
  find_movidesk_contact_by_email:
    "Resolve e-mail -> cod_ref usando o diretório local movidesk_contatos. Retorna null se não encontrar.",
  search_ad_users: "Busca colaboradores Viasoft no Active Directory por nome/usuário/e-mail.",
  list_customer_organizations:
    "Busca organizações na lista LOCAL sincronizada (fonte preferencial para fluxos com catálogo confirmado, ex: Voors, GCC). Se não encontrar nada (lista local vazia/desatualizada ou organização não coberta por esses fluxos), use movidesk_search_organizations para buscar direto na API real do Movidesk antes de dizer que a organização não existe.",
  movidesk_search_organizations:
    "Busca organizações direto na API real do Movidesk por nome/razão social (contains em businessName). Use como fallback quando list_customer_organizations não encontrar a organização. Retorna id (cod_ref), businessName, personType, profileType — confira esses campos para confirmar que é de fato uma organização antes de usar o id para filtrar chamados.",
  get_flow_config:
    "Retorna a configuração validada de um fluxo (serviço, equipe, formulário, campos adicionais, notas de comportamento confirmado). SEMPRE use esta ferramenta em vez de lembrar IDs de memória.",
  movidesk_get_ticket: "Busca um chamado Movidesk por ID.",
  movidesk_search_tickets: "Busca chamados Movidesk via OData. $select é obrigatório.",
  movidesk_create_ticket:
    "Cria um chamado Movidesk. Exige idempotency_key (gerada previamente). Só cria de fato se a chave ainda não tiver um resultado bem-sucedido.",
  movidesk_patch_ticket:
    "Atualiza um chamado Movidesk existente (status, campos, ações). Ao alterar status, inclua também justification.",
  movidesk_get_person: "Busca uma pessoa Movidesk por cod_ref.",
  movidesk_search_persons: "Busca pessoas Movidesk via OData. $select é obrigatório.",
  movidesk_get_service: "Busca um serviço Movidesk por ID.",
  movidesk_search_services: "Busca serviços Movidesk via OData. $select é obrigatório.",
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function audit(
  ctx: AgentContext,
  fields: { intent: string; operation: string; endpoint: string; targetId?: string | number; payload?: unknown },
  outcome: { httpStatus?: number; returnedId?: string | number; verified?: boolean; errorCode?: string },
): Promise<void> {
  await recordAuditEvent({
    timestamp: new Date().toISOString(),
    authenticatedUser: { id_local: ctx.authenticatedUser.id_local, email: ctx.authenticatedUser.email },
    intent: fields.intent,
    operation: fields.operation,
    endpoint: fields.endpoint,
    targetId: fields.targetId,
    payloadHash: fields.payload !== undefined ? hashPayload(fields.payload) : undefined,
    correlationId: newCorrelationId(),
    ...outcome,
  });
}

/**
 * Envolve `dispatchToolInner` para publicar eventos de observabilidade (dashboard):
 * início e fim de cada chamada de ferramenta, com input/output redigidos e truncados
 * por `sanitizeForDashboard` — nunca o payload cru (que pode ter PII completa).
 */
export async function dispatchTool(name: ToolName, rawInput: unknown, ctx: AgentContext): Promise<unknown> {
  const id = newEventId();
  const start = Date.now();
  emitEvent({
    kind: "tool_call_start",
    id,
    timestamp: new Date().toISOString(),
    tool: name,
    input: sanitizeForDashboard(rawInput),
  });
  try {
    const result = await dispatchToolInner(name, rawInput, ctx);
    emitEvent({
      kind: "tool_call_end",
      id,
      timestamp: new Date().toISOString(),
      tool: name,
      status: "ok",
      durationMs: Date.now() - start,
      output: sanitizeForDashboard(result),
    });
    return result;
  } catch (err) {
    emitEvent({
      kind: "tool_call_end",
      id,
      timestamp: new Date().toISOString(),
      tool: name,
      status: "error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function dispatchToolInner(name: ToolName, rawInput: unknown, ctx: AgentContext): Promise<unknown> {
  const schema = schemas[name];
  if (!schema) throw new Error(`Ferramenta desconhecida: ${name}`);
  const input = schema.parse(rawInput) as any;

  switch (name) {
    case "get_authenticated_user":
      return ctx.authenticatedUser;

    case "find_movidesk_contact_by_email":
      return (await findContactByEmail(input.email)) ?? { found: false };

    case "search_ad_users":
      return searchAdUsers(input.query, input.limit);

    case "list_customer_organizations":
      return listOrganizations(input.query, input.limit);

    case "movidesk_search_organizations":
      return searchOrganizationsByName(input.query, input.top);

    case "get_flow_config":
      return getFlowConfig(input.flow_name);

    case "movidesk_get_ticket":
      return getTicket(input.id, input.select, input.expand);

    case "movidesk_search_tickets":
      return searchTickets({
        filter: input.filter,
        select: input.select,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    case "movidesk_create_ticket": {
      const reserved = await idempotencyReserve(input.idempotency_key);
      if (reserved.status === "succeeded") {
        // Já criado antes com esta mesma chave — não repetir o POST.
        return { alreadyCreated: true, result: reserved.result };
      }
      try {
        const result = await createTicket(input.payload as any, input.return_all_properties);
        await idempotencyPut({ ...reserved, status: "succeeded", result });
        await audit(
          ctx,
          { intent: "criar chamado", operation: name, endpoint: "POST /tickets", payload: input.payload },
          { httpStatus: 200, returnedId: result.id },
        );
        return result;
      } catch (err) {
        const errorCode = err instanceof MovideskApiError ? `movidesk:${err.status}:${err.propertyName ?? ""}` : "unknown";
        await idempotencyPut({ ...reserved, status: "failed", error: String(err) });
        await audit(
          ctx,
          { intent: "criar chamado", operation: name, endpoint: "POST /tickets", payload: input.payload },
          { errorCode },
        );
        throw err;
      }
    }

    case "movidesk_patch_ticket": {
      try {
        const result = await patchTicket(input.id, input.payload as any);
        await audit(
          ctx,
          {
            intent: input.intent,
            operation: name,
            endpoint: "PATCH /tickets",
            targetId: input.id,
            payload: input.payload,
          },
          { httpStatus: 200, changedFields: Object.keys(input.payload) } as any,
        );
        return result;
      } catch (err) {
        const errorCode = err instanceof MovideskApiError ? `movidesk:${err.status}:${err.propertyName ?? ""}` : "unknown";
        await audit(
          ctx,
          {
            intent: input.intent,
            operation: name,
            endpoint: "PATCH /tickets",
            targetId: input.id,
            payload: input.payload,
          },
          { errorCode },
        );
        throw err;
      }
    }

    case "movidesk_get_person":
      return getPerson(input.id);

    case "movidesk_search_persons":
      return searchPersons({
        filter: input.filter,
        select: input.select,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    case "movidesk_get_service":
      return getService(input.id);

    case "movidesk_search_services":
      return searchServices({
        filter: input.filter,
        select: input.select,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    default:
      throw new Error(`Ferramenta não implementada: ${name}`);
  }
}

export { odataEscape };
export async function idempotencyLookup(key: string) {
  return idempotencyGet(key);
}
