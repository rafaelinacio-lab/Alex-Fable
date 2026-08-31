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
import { searchKnownServices } from "../local/serviceCatalog.js";
import { searchAdUsers } from "../local/directory.js";
import {
  getTicket,
  getTicketByProtocol,
  getTicketActionHtml,
  searchTickets,
  searchTicketsPast,
  searchTicketsExhaustive,
  createTicket,
  patchTicket,
} from "../movidesk/tickets.js";
import { getPerson, searchPersons, searchOrganizationsByName } from "../movidesk/persons.js";
import { getService, searchServices } from "../movidesk/services.js";
import { odataEscape, MovideskApiError } from "../movidesk/client.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { idempotencyGet, idempotencyPut, idempotencyReserve } from "../store/idempotency.js";
import { emitEvent, newEventId, sanitizeForDashboard } from "../observability/eventBus.js";
import { exportRowsToExcel } from "../local/export.js";
import { exportRowsToPdf, PDF_MAX_ROWS } from "../local/pdfExport.js";
import { runFollowUpCheck } from "./followUp.js";
import { FOLLOW_UP_CONFIG } from "../config/followUp.js";
import path from "node:path";

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
  list_known_services: z.object({
    query: z.string().default(""),
    limit: z.number().int().positive().max(50).default(10),
  }),
  get_flow_config: z.object({ flow_name: z.enum(FLOW_NAMES) }),

  movidesk_get_ticket: z.object({
    id: z.number().int().positive(),
    select: z.array(z.string()).optional(),
    expand: z.string().optional(),
  }),
  movidesk_get_ticket_by_protocol: z.object({
    protocol: z.string().min(1),
    select: z.array(z.string()).optional(),
    expand: z.string().optional(),
  }),
  movidesk_get_ticket_action_html: z.object({
    id: z.number().int().positive().optional(),
    protocol: z.string().min(1).optional(),
    action_id: z.number().int().positive().optional(),
  }),
  movidesk_search_tickets: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
  movidesk_search_tickets_past: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
  movidesk_search_tickets_exhaustive: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    source: z.enum(["current", "past"]).default("current"),
    page_size: z.number().int().positive().max(100).default(100),
    max_pages: z.number().int().positive().max(150).default(50),
    only_open: z.boolean().default(false),
  }),
  export_tickets_to_excel: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    columns: z.array(z.object({ header: z.string(), key: z.string() })).optional(),
    filename_hint: z.string().min(1),
  }),
  export_tickets_search_to_excel: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    source: z.enum(["current", "past"]).default("current"),
    page_size: z.number().int().positive().max(100).default(100),
    max_pages: z.number().int().positive().max(150).default(50),
    only_open: z.boolean().default(false),
    columns: z.array(z.object({ header: z.string(), key: z.string() })).optional(),
    filename_hint: z.string().min(1),
  }),
  export_tickets_to_pdf: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    columns: z.array(z.object({ header: z.string(), key: z.string(), width: z.number().positive().optional() })).optional(),
    filename_hint: z.string().min(1),
    title: z.string().optional(),
  }),
  export_tickets_search_to_pdf: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    source: z.enum(["current", "past"]).default("current"),
    page_size: z.number().int().positive().max(100).default(100),
    max_pages: z.number().int().positive().max(150).default(50),
    only_open: z.boolean().default(false),
    columns: z.array(z.object({ header: z.string(), key: z.string(), width: z.number().positive().optional() })).optional(),
    filename_hint: z.string().min(1),
    title: z.string().optional(),
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
  check_pending_customer_tickets: z.object({}),
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
  list_known_services:
    "Busca no catálogo LOCAL sincronizado de serviços (id, nome, e 'servico' = trilha hierárquica completa, ex: 'GCC » Construshow'). USE ISTO PRIMEIRO para resolver um serviço, antes de movidesk_search_services — a mesma folha pode existir sob várias hierarquias com IDs diferentes (ex: 'Construshow' aparece 8 vezes: top-level e sob GCC, HOK Cursos, Oracle Cloud, Migração, etc.). Para montar o filtro de chamados serviceFull/any(s: s eq '...'), use o campo 'nome' (a folha, ex: 'Construshow') — é o texto que aparece dentro do array serviceFull de cada ticket. Use 'servico' (a trilha completa) só para APRESENTAR ao usuário/confirmar qual hierarquia ele quer, já que o filtro por 'nome' sozinho pega tickets de todas as hierarquias com essa folha (geralmente é isso que o usuário quer ao pedir 'chamados do serviço X'; se ele quiser só uma hierarquia específica, isso ainda não tem filtro confirmado — trate como seção 9, diagnóstico).",
  get_flow_config:
    "Retorna a configuração validada de um fluxo (serviço, equipe, formulário, campos adicionais, notas de comportamento confirmado). SEMPRE use esta ferramenta em vez de lembrar IDs de memória.",
  movidesk_get_ticket: "Busca um chamado Movidesk por ID.",
  movidesk_get_ticket_by_protocol: "Busca um chamado Movidesk pelo protocolo (ex: MOVI202109000001).",
  movidesk_get_ticket_action_html:
    "Retorna o HTML de uma ação de um chamado (o campo description normal só traz texto). Informe id OU protocol, e opcionalmente action_id.",
  movidesk_search_tickets:
    "Busca chamados Movidesk via OData (rota /tickets, só cobre lastUpdate < 90 dias). $select é obrigatório. Retorna no máximo 'top' registros — para saber se há mais, compare o tamanho do retorno com 'top', ou melhor: use movidesk_search_tickets_exhaustive quando precisar do total real.",
  movidesk_search_tickets_past:
    "Como movidesk_search_tickets, mas na rota /tickets/past (chamados com lastUpdate há mais de 90 dias). Sintaxe assumida por analogia — não 100% confirmada; se o retorno vier estranho, trate como comportamento não documentado.",
  movidesk_search_tickets_exhaustive:
    "Pagina AUTOMATICAMENTE até o fim real dos resultados (ou até um limite de segurança) e devolve o total. Use quando o usuário pedir 'todos os chamados' ou uma contagem/quantidade exata SEM pedir exportação — nunca monte esse total manualmente somando chamadas separadas de movidesk_search_tickets. Se o pedido também envolver Excel/planilha, use export_tickets_search_to_excel diretamente em vez desta (evita ter que retransmitir os registros de volta para você). O retorno inclui hitCap/pagesFetched: se hitCap=true, o total pode ser maior que o array devolvido — reporte isso honestamente ao usuário (a API do Movidesk não suporta $count, então não há como saber o total exato além de paginar até o fim). Para 'chamados em aberto', use only_open:true (NÃO tente montar isso no seu próprio filter com ne/not — não são operadores confirmados nesta API, e já causou um bug real: chamados 'Resolvido' aparecendo num pedido de 'em aberto'). only_open filtra baseStatus no servidor, depois de buscar, usando o enum confirmado (New/InAttendance/Stopped = aberto; Resolved/Canceled/Closed = não).",
  export_tickets_to_excel:
    "Grava um .xlsx a partir de linhas que VOCÊ já tem em mãos (até 200 linhas — ex: um resultado pequeno que você já resumiu na conversa). NUNCA use isto para exportar o resultado de uma busca grande: você teria que retransmitir cada registro como texto na chamada de ferramenta, e isso trunca silenciosamente antes de completar (é exatamente o bug já visto: só saíam 20-500 de 643 linhas). Para exportar o resultado de uma busca — que é o caso mais comum — use export_tickets_search_to_excel, que busca e grava o arquivo inteiro no servidor, sem os dados passarem por você.",
  export_tickets_search_to_excel:
    "**Ferramenta certa para 'me dá um Excel/planilha desses chamados'.** Faz a busca exaustiva (como movidesk_search_tickets_exhaustive) E grava o .xlsx em uma única chamada de ferramenta — os registros nunca precisam ser retransmitidos por você, então não há risco de truncar o arquivo. Devolve o caminho do arquivo, o total de linhas gravadas, e se a contagem é exata. Use com o MESMO filter/select que você usaria em movidesk_search_tickets_exhaustive, incluindo only_open:true quando o pedido for 'chamados em aberto' (ver descrição de movidesk_search_tickets_exhaustive — não tente filtrar status via OData ne/not).",
  export_tickets_to_pdf:
    "Grava um .pdf (tabela simples, paginada) a partir de linhas que VOCÊ já tem em mãos (até 200 linhas). Mesma ressalva de export_tickets_to_excel: NUNCA use para exportar o resultado de uma busca grande — os dados teriam que ser retransmitidos por você e isso trunca silenciosamente. Para exportar o resultado de uma busca, use export_tickets_search_to_pdf.",
  export_tickets_search_to_pdf:
    "**Ferramenta certa para 'me dá um PDF desses chamados'.** Faz a busca exaustiva E grava o .pdf (tabela paginada automaticamente) em uma única chamada de ferramenta — os registros nunca passam por você. Devolve o caminho do arquivo e o total de linhas. Use com o MESMO filter/select/only_open que usaria em movidesk_search_tickets_exhaustive. Limite bem menor que o Excel (5.000 linhas) — PDF é para relatório legível, não para descarregar bases inteiras; se o volume for muito grande, prefira export_tickets_search_to_excel e diga isso ao usuário.",
  movidesk_create_ticket:
    "Cria um chamado Movidesk. Exige idempotency_key (gerada previamente). Só cria de fato se a chave ainda não tiver um resultado bem-sucedido.",
  movidesk_patch_ticket:
    "Atualiza um chamado Movidesk existente (status, campos, ações). Ao alterar status, inclua também justification.",
  movidesk_get_person: "Busca uma pessoa Movidesk por cod_ref.",
  movidesk_search_persons: "Busca pessoas Movidesk via OData. $select é obrigatório.",
  check_pending_customer_tickets:
    "Roda AGORA (fora do agendamento automático de 24h) a verificação de chamados 'Aguardando Retorno do Cliente'/'Aguardando Validação do Cliente' há tempo demais (regra completa em src/agent/followUp.ts: última ação tem que ser do owner, prazo em horas úteis conforme o SLA). Chamados que qualificam recebem uma ação pública automática de cobrança nesta mesma chamada — não é só uma prévia. Só faz sentido se FOLLOWUP_AUTOMATION_ENABLED=true (senão devolve checkedCount:0 sem buscar nada). Use quando o usuário pedir explicitamente para checar/cobrar agora, fora do ciclo automático.",
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
 * Publica um evento "file_ready" para o painel web assim que um export (Excel/PDF) é
 * gravado com sucesso — a aba Conversa mostra um cartão de download imediatamente,
 * independente de como o modelo descrever o resultado em texto. Ver
 * src/server/dashboard.ts (rota GET /exports/:filename que efetivamente serve o arquivo).
 */
function announceFileReady(filePath: string, rowCount: number, format: "xlsx" | "pdf"): void {
  const filename = path.basename(filePath);
  emitEvent({
    kind: "file_ready",
    id: newEventId(),
    timestamp: new Date().toISOString(),
    filename,
    downloadUrl: `/exports/${encodeURIComponent(filename)}`,
    rowCount,
    format,
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

    case "list_known_services":
      return searchKnownServices(input.query, input.limit);

    case "get_flow_config":
      return getFlowConfig(input.flow_name);

    case "movidesk_get_ticket":
      return getTicket(input.id, input.select, input.expand);

    case "movidesk_get_ticket_by_protocol":
      return getTicketByProtocol(input.protocol, input.select, input.expand);

    case "movidesk_get_ticket_action_html": {
      if (!input.id && !input.protocol) {
        throw new Error("Informe id ou protocol para buscar o HTML da ação.");
      }
      const ref = input.id ? { id: input.id } : { protocol: input.protocol };
      return getTicketActionHtml(ref, input.action_id);
    }

    case "movidesk_search_tickets":
      return searchTickets({
        filter: input.filter,
        select: input.select,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    case "movidesk_search_tickets_past":
      return searchTicketsPast({
        filter: input.filter,
        select: input.select,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    case "movidesk_search_tickets_exhaustive": {
      const result = await searchTicketsExhaustive(
        { filter: input.filter, select: input.select },
        { pageSize: input.page_size, maxPages: input.max_pages, source: input.source, onlyOpen: input.only_open },
      );
      // Só devolve uma amostra inline para o modelo comentar/resumir — devolver os
      // milhares de registros completos de volta ao contexto do modelo é desperdício
      // (e não é mais necessário: exportação usa export_tickets_search_to_excel, que
      // não passa pelos tokens do modelo).
      const MAX_INLINE_TICKETS = 50;
      const truncatedForDisplay = result.tickets.length > MAX_INLINE_TICKETS;
      return {
        tickets: result.tickets.slice(0, MAX_INLINE_TICKETS),
        tickets_truncated_for_display: truncatedForDisplay,
        total_found: result.tickets.length,
        pages_fetched: result.pagesFetched,
        exact_total: !result.hitCap,
        note:
          (result.hitCap
            ? `Atingiu o limite de segurança de ${input.max_pages} páginas (${input.page_size} por página) — pode haver mais registros além destes ${result.tickets.length}. A API do Movidesk não suporta $count. Se precisar do total real, chame esta mesma ferramenta DE NOVO com max_pages maior (até 150) em vez de paginar manualmente com movidesk_search_tickets — isso é uma única chamada de ferramenta, não uma série de confirmações com o usuário.`
            : `Total exato: a última página retornou menos que ${input.page_size} registros, confirmando que não há mais resultados.`) +
          (truncatedForDisplay
            ? ` Só as primeiras ${MAX_INLINE_TICKETS} linhas vieram no campo "tickets" (para você comentar/resumir) — o total_found (${result.tickets.length}) já é a contagem real de todos. Para gerar um arquivo com TODOS, use export_tickets_search_to_excel com o mesmo filter/select em vez de tentar retransmitir estes registros.`
            : "") +
          (input.only_open && result.fetchedBeforeOpenFilter !== undefined
            ? ` Filtro only_open aplicado: de ${result.fetchedBeforeOpenFilter} chamados retornados pela busca, ${result.tickets.length} estão em aberto (baseStatus New/InAttendance/Stopped).`
            : ""),
      };
    }

    case "export_tickets_to_excel": {
      const columns = input.columns ?? Object.keys(input.rows[0]).map((key: string) => ({ header: key, key }));
      const result = await exportRowsToExcel(input.rows, columns, input.filename_hint);
      announceFileReady(result.path, result.rowCount, "xlsx");
      return { ...result, downloadUrl: `/exports/${encodeURIComponent(path.basename(result.path))}` };
    }

    case "export_tickets_search_to_excel": {
      const result = await searchTicketsExhaustive(
        { filter: input.filter, select: input.select },
        { pageSize: input.page_size, maxPages: input.max_pages, source: input.source, onlyOpen: input.only_open },
      );
      if (result.tickets.length === 0) {
        return {
          path: null,
          rowCount: 0,
          exact_total: !result.hitCap,
          note: input.only_open
            ? `Nenhum chamado em aberto encontrado (de ${result.fetchedBeforeOpenFilter ?? 0} retornados pela busca) — nada para exportar.`
            : "Nenhum chamado encontrado — nada para exportar.",
        };
      }
      const columns = input.columns ?? input.select.map((key: string) => ({ header: key, key }));
      const exportResult = await exportRowsToExcel(result.tickets, columns, input.filename_hint);
      announceFileReady(exportResult.path, exportResult.rowCount, "xlsx");
      return {
        ...exportResult,
        downloadUrl: `/exports/${encodeURIComponent(path.basename(exportResult.path))}`,
        exact_total: !result.hitCap,
        note:
          (result.hitCap
            ? `O arquivo contém ${exportResult.rowCount} chamados — atingiu o limite de segurança de ${input.max_pages} páginas, pode haver mais. Chame esta mesma ferramenta de novo com max_pages maior (até 150) se precisar de todos.`
            : `O arquivo contém todos os ${exportResult.rowCount} chamados encontrados (contagem exata — a API do Movidesk não suporta $count, mas a última página veio incompleta, confirmando o fim dos resultados).`) +
          (input.only_open && result.fetchedBeforeOpenFilter !== undefined
            ? ` Filtro only_open aplicado: de ${result.fetchedBeforeOpenFilter} chamados retornados pela busca, ${exportResult.rowCount} estavam em aberto.`
            : ""),
      };
    }

    case "export_tickets_to_pdf": {
      const columns = input.columns ?? Object.keys(input.rows[0]).map((key: string) => ({ header: key, key }));
      const result = await exportRowsToPdf(input.rows, columns, input.filename_hint, { title: input.title });
      announceFileReady(result.path, result.rowCount, "pdf");
      return { ...result, downloadUrl: `/exports/${encodeURIComponent(path.basename(result.path))}` };
    }

    case "export_tickets_search_to_pdf": {
      const result = await searchTicketsExhaustive(
        { filter: input.filter, select: input.select },
        { pageSize: input.page_size, maxPages: input.max_pages, source: input.source, onlyOpen: input.only_open },
      );
      if (result.tickets.length === 0) {
        return {
          path: null,
          rowCount: 0,
          exact_total: !result.hitCap,
          note: input.only_open
            ? `Nenhum chamado em aberto encontrado (de ${result.fetchedBeforeOpenFilter ?? 0} retornados pela busca) — nada para exportar.`
            : "Nenhum chamado encontrado — nada para exportar.",
        };
      }
      if (result.tickets.length > PDF_MAX_ROWS) {
        return {
          path: null,
          rowCount: 0,
          exact_total: !result.hitCap,
          note: `A busca encontrou ${result.tickets.length} chamados, acima do limite de ${PDF_MAX_ROWS} para PDF (que é pensado para relatórios legíveis, não para descarregar bases inteiras). Use export_tickets_search_to_excel para este volume, ou refine o filtro (período/status/organização) para reduzir o total.`,
        };
      }
      const columns = input.columns ?? input.select.map((key: string) => ({ header: key, key }));
      const exportResult = await exportRowsToPdf(result.tickets, columns, input.filename_hint, { title: input.title });
      announceFileReady(exportResult.path, exportResult.rowCount, "pdf");
      return {
        ...exportResult,
        downloadUrl: `/exports/${encodeURIComponent(path.basename(exportResult.path))}`,
        exact_total: !result.hitCap,
        note:
          (result.hitCap
            ? `O arquivo contém ${exportResult.rowCount} chamados — atingiu o limite de segurança de ${input.max_pages} páginas, pode haver mais. Chame esta mesma ferramenta de novo com max_pages maior (até 150) se precisar de todos.`
            : `O arquivo contém todos os ${exportResult.rowCount} chamados encontrados (contagem exata — a última página veio incompleta, confirmando o fim dos resultados).`) +
          (input.only_open && result.fetchedBeforeOpenFilter !== undefined
            ? ` Filtro only_open aplicado: de ${result.fetchedBeforeOpenFilter} chamados retornados pela busca, ${exportResult.rowCount} estavam em aberto.`
            : ""),
      };
    }

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

    case "check_pending_customer_tickets": {
      if (!FOLLOW_UP_CONFIG.enabled) {
        return {
          checkedCount: 0,
          charged: [],
          skipped: [],
          errors: [],
          note: "FOLLOWUP_AUTOMATION_ENABLED não está 'true' — a automação de cobrança está desligada, nada foi verificado.",
        };
      }
      return runFollowUpCheck();
    }

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
