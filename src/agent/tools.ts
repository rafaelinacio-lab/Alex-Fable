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
import { getPerson, searchPersons, searchPersonsExhaustive, filterByCustomField, getPersonsInOrganizations, searchOrganizationsByName } from "../movidesk/persons.js";
import { getService, searchServices } from "../movidesk/services.js";
import { odataEscape, MovideskApiError } from "../movidesk/client.js";
import { recordAuditEvent, hashPayload, newCorrelationId } from "../store/audit.js";
import { idempotencyGet, idempotencyPut, idempotencyReserve } from "../store/idempotency.js";
import { emitEvent, newEventId, sanitizeForDashboard } from "../observability/eventBus.js";
import { exportRowsToExcel } from "../local/export.js";
import { exportRowsToPdf, PDF_MAX_ROWS } from "../local/pdfExport.js";
import { runAllFollowUpChecks } from "./followUp.js";
import { isFollowUpAutomationEnabled } from "../config/followUp.js";
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
    /**
     * $expand para trazer objetos/coleções de navegação que NÃO vêm no $select puro.
     * Exemplos confirmados: "owner" (objeto singular), "clients" (coleção), "actions".
     * Múltiplos valores separados por vírgula: "owner,clients".
     */
    expand: z.string().optional(),
    page_size: z.number().int().positive().max(1000).default(1000),
    max_pages: z.number().int().positive().max(200).default(100),
    only_open: z.boolean().default(false),
  }),
  /**
   * Busca paralela com múltiplos filtros — replica o padrão do fluxo n8n de referência:
   * duas ramificações independentes (ex: abertos em 2026 E fechados em 2026) executadas
   * em paralelo com Promise.all, cada uma com paginação dual (current + past), depois
   * consolidadas. Ideal quando o usuário quer CONTAR chamados por período/condição
   * diferente em uma única chamada.
   */
  movidesk_search_tickets_parallel: z.object({
    branches: z
      .array(
        z.object({
          label: z.string().min(1),
          filter: z.string(),
          only_open: z.boolean().default(false),
        }),
      )
      .min(2)
      .max(5),
    select: z.array(z.string()).min(1),
    /** $expand compartilhado por todas as branches (ex: "owner,clients"). */
    expand: z.string().optional(),
    page_size: z.number().int().positive().max(1000).default(1000),
    max_pages: z.number().int().positive().max(200).default(100),
  }),
  export_tickets_to_excel: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    columns: z.array(z.object({ header: z.string(), key: z.string() })).optional(),
    filename_hint: z.string().min(1),
  }),
  export_tickets_search_to_excel: z.object({
    filter: z.string(),
    select: z.array(z.string()).min(1),
    expand: z.string().optional(),
    page_size: z.number().int().positive().max(1000).default(1000),
    max_pages: z.number().int().positive().max(200).default(100),
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
    expand: z.string().optional(),
    page_size: z.number().int().positive().max(1000).default(1000),
    max_pages: z.number().int().positive().max(200).default(100),
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
    expand: z.string().optional(),
    orderby: z.string().optional(),
    top: z.number().int().positive().max(100).default(20),
    skip: z.number().int().nonnegative().optional(),
  }),
  /**
   * Busca paginada de pessoas/organizações filtrando por um campo adicional específico.
   * Como o filtro OData por customFieldValues/any() não está confirmado para /persons,
   * a ferramenta busca com $expand=customFieldValues e filtra localmente.
   * Use para encontrar "todas as organizações com campo X = Y" ou
   * "todas as pessoas vinculadas a organizações com campo X = Y".
   */
  movidesk_search_persons_by_custom_field: z.object({
    custom_field_id: z.number().int().positive(),
    /** Para campos do tipo Lista de valores / Seleção única ou múltipla: valor de items[].customFieldItem. Busca por substring (case-insensitive). */
    custom_field_item: z.string().optional(),
    /** Para campos do tipo Texto / Data / Numérico: valor em value. Busca por substring (case-insensitive). */
    value: z.string().optional(),
    /** OData filter base (além do filtro por customField). Ex: "personType eq 2" para só organizações. */
    base_filter: z.string().optional(),
    select: z.array(z.string()).min(1),
    /** Campos a expandir além de customFieldValues (que é sempre incluído). */
    extra_expand: z.string().optional(),
    /** Máximo de registros a varrer antes de parar. Default 3000. */
    max_records: z.number().int().positive().max(10000).default(3000),
  }),
  /**
   * Dado um conjunto de identificadores de organizações (IDs, CNPJs ou razões sociais),
   * retorna todas as pessoas físicas (personType=1) vinculadas a elas.
   * Resolve cada identificador para um cod_ref de org antes de buscar as pessoas.
   * Busca todos os contatos e filtra localmente — não faz N chamadas individuais.
   */
  movidesk_get_persons_in_organizations: z.object({
    /** IDs (cod_ref) diretos de organizações já conhecidos. */
    org_ids: z.array(z.string().min(1)).max(500).default([]),
    /** CNPJs a resolver para org — busca via campo cpfCnpj da pessoa (tipo Empresa). */
    org_cnpjs: z.array(z.string().min(1)).max(50).default([]),
    /** Razões sociais / nomes para resolver via contains(businessName). */
    org_names: z.array(z.string().min(1)).max(50).default([]),
    select: z.array(z.string()).min(1),
    /** $expand extra (ex: "customFieldValues") além do que já é incluído. */
    extra_expand: z.string().optional(),
    /** Máximo de páginas de 100 por organização (padrão 50 = até 5 000 por org). */
    max_pages: z.number().int().positive().max(500).default(50),
    /** Se true, inclui 'isActive eq true' no filtro OData — retorna só contatos ativos. */
    only_active: z.boolean().default(false),
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
    "Busca exaustiva padrão — percorre AUTOMATICAMENTE as duas rotas da API em sequência (Fase 1: /tickets → Fase 2: /tickets/past) até o fim real dos resultados em cada uma, exatamente como o fluxo n8n de referência. Use SEMPRE que precisar de total real ou de 'todos os chamados' — nunca soma manualmente chamadas separadas de movidesk_search_tickets. NÃO há parâmetro 'source': as duas fases são sempre percorridas; omitir uma significaria perder chamados silenciosamente (recentes ficam só em /tickets, antigos só em /tickets/past). O retorno inclui phasesCompleted (quais fases terminaram normalmente) e hitCap (true = limite de segurança atingido, total pode ser maior — reporte isso ao usuário). Para exportação em Excel/PDF, use export_tickets_search_to_excel / export_tickets_search_to_pdf diretamente. Para 'chamados em aberto', use only_open:true — NÃO filtre status via OData ne/not (operadores não confirmados nesta API, já causaram bug real: Resolvidos aparecendo como Abertos). IMPORTANTE: 'owner' e 'clients' são objetos/coleções de navegação OData — eles NÃO vêm no $select puro. Para trazê-los, passe expand:'owner' e/ou expand:'clients' (ou ambos: expand:'owner,clients'). Sem isso o campo virá ausente mesmo que listado em select.",
  movidesk_search_tickets_parallel:
    "Busca paralela com múltiplos filtros independentes — replica o padrão de DUAS RAMIFICAÇÕES do fluxo n8n de referência. Cada branch define seu próprio filter OData e label (ex: {label:'abertos_2026', filter:'createdDate ge ...'} e {label:'fechados_2026', filter:'resolvedIn ge ...'}). Todas as branches executam em paralelo (Promise.all), cada uma com paginação dual automática (current + past), e os resultados são consolidados ao final. Use este tool quando o usuário pedir CONTAGEM ou COMPARAÇÃO de chamados por diferentes critérios de data/status em uma única chamada — ex: 'quantos chamados foram abertos e quantos foram fechados em 2026'. O retorno traz counts e uma amostra por branch, mais o union_count (tickets únicos, desduplicados por id). Para exportar múltiplas branches para Excel, use export_tickets_search_to_excel separadamente para cada filter.",
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
  movidesk_get_persons_in_organizations:
    "Retorna todas as pessoas vinculadas a um conjunto de organizações usando o filtro OData confirmado 'relationships/any(r: r/id eq ORG_ID)' — uma query direcionada por organização, em paralelo. Aceita org_ids (cod_ref direto), org_cnpjs (CNPJ — resolve via cpfCnpj) e org_names (razão social — resolve via contains). Use only_active:true para restringir a isActive eq true. Use APÓS movidesk_search_persons_by_custom_field quando precisar das pessoas de organizações filtradas por campo adicional, ou diretamente quando já tiver IDs/CNPJs/nomes. NUNCA use movidesk_search_persons com organization/id no filter — esse caminho não é suportado pela API (HTTP 400 confirmado).",
  movidesk_get_person: "Busca uma pessoa Movidesk por cod_ref.",
  movidesk_search_persons:
    "Busca pessoas Movidesk via OData. $select é obrigatório. Passe expand:'customFieldValues' para trazer os campos adicionais de cada registro — necesário para ler campos como 'Vertical Viasoft', 'Departamento', etc.",
  movidesk_search_persons_by_custom_field:
    "Localiza pessoas ou organizações que tenham um campo adicional específico preenchido com determinado valor. Como o filtro OData por customFieldValues/any() não está confirmado para /persons, a ferramenta busca com $expand=customFieldValues e faz filtro local — pode varrer até max_records registros. Use custom_field_id (numérico, catálogo em docs/movidesk-custom-fields.md) + custom_field_item (para lista/seleção) ou value (para texto/número/data). Para 'organizações com Vertical Viasoft = Agronegocio': custom_field_id=29433, custom_field_item='Agronegocio', base_filter='personType eq 2'. Atenção: campo 29433 é 'Seleção múltipla' em Pessoa — um registro pode ter vários itens.",
  check_pending_customer_tickets:
    "Roda AGORA (fora do agendamento automático) a verificação de cobrança para TODAS as equipes com um perfil habilitado no painel (aba Automação) — cada perfil tem sua própria equipe, status monitorados e regra de SLA (ver src/agent/followUp.ts: última ação tem que ser do owner, prazo em horas úteis conforme o expediente configurado naquele perfil). Chamados que qualificam recebem uma ação pública automática de cobrança nesta mesma chamada — não é só uma prévia. Só faz sentido se FOLLOWUP_AUTOMATION_ENABLED=true E houver ao menos um perfil habilitado (senão devolve results:[] sem buscar nada). Use quando o usuário pedir explicitamente para checar/cobrar agora, fora do ciclo automático.",
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
        { filter: input.filter, select: input.select, expand: input.expand },
        { pageSize: input.page_size, maxPages: input.max_pages, onlyOpen: input.only_open },
      );
      // Só devolve uma amostra inline para o modelo comentar/resumir — devolver os
      // milhares de registros completos de volta ao contexto do modelo é desperdício
      // (e não é mais necessário: exportação usa export_tickets_search_to_excel, que
      // não passa pelos tokens do modelo).
      const MAX_INLINE_TICKETS = 50;
      const truncatedForDisplay = result.tickets.length > MAX_INLINE_TICKETS;
      const phasesMsg = `Fases percorridas: ${result.phasesCompleted.join(" + ") || "nenhuma concluída (limite atingido antes)"}.`;
      return {
        tickets: result.tickets.slice(0, MAX_INLINE_TICKETS),
        tickets_truncated_for_display: truncatedForDisplay,
        total_found: result.tickets.length,
        pages_fetched: result.pagesFetched,
        phases_completed: result.phasesCompleted,
        exact_total: !result.hitCap,
        note:
          phasesMsg +
          " " +
          (result.hitCap
            ? `Atingiu o limite de segurança de ${input.max_pages} páginas (${input.page_size} por página) — pode haver mais registros. A API do Movidesk não suporta $count. Se precisar do total real, chame novamente com max_pages maior (até 200).`
            : `Total exato: ambas as fases (current + past) terminaram naturalmente — não há mais resultados.`) +
          (truncatedForDisplay
            ? ` Só as primeiras ${MAX_INLINE_TICKETS} linhas vieram no campo "tickets" — o total_found (${result.tickets.length}) já é a contagem real. Para um arquivo com TODOS, use export_tickets_search_to_excel com o mesmo filter/select.`
            : "") +
          (input.only_open && result.fetchedBeforeOpenFilter !== undefined
            ? ` Filtro only_open aplicado: de ${result.fetchedBeforeOpenFilter} chamados retornados pela busca, ${result.tickets.length} estão em aberto (baseStatus New/InAttendance/Stopped).`
            : ""),
      };
    }

    case "movidesk_search_tickets_parallel": {
      // Executa todas as branches em paralelo — mesmo padrão das duas ramificações do n8n
      const branchResults = await Promise.all(
        input.branches.map(async (branch: { label: string; filter: string; only_open: boolean }) => {
          const result = await searchTicketsExhaustive(
            { filter: branch.filter, select: input.select, expand: input.expand },
            { pageSize: input.page_size, maxPages: input.max_pages, onlyOpen: branch.only_open },
          );
          return { label: branch.label, only_open: branch.only_open, result };
        }),
      );

      // Consolida: união desduplicada por id (mesmo que um ticket apareça em mais de uma branch)
      const seenIds = new Set<number>();
      let unionCount = 0;
      const MAX_INLINE = 20;
      const branchSummaries = branchResults.map(({ label, only_open, result }) => {
        for (const t of result.tickets) {
          if (typeof t.id === "number" && !seenIds.has(t.id)) {
            seenIds.add(t.id);
            unionCount++;
          }
        }
        const phasesMsg = result.phasesCompleted.join(" + ") || "nenhuma concluída (limite atingido)";
        return {
          label,
          count: result.tickets.length,
          exact: !result.hitCap,
          phases_completed: result.phasesCompleted,
          hit_cap: result.hitCap,
          pages_fetched: result.pagesFetched,
          tickets_sample: result.tickets.slice(0, MAX_INLINE),
          note:
            `Fases: ${phasesMsg}.` +
            (result.hitCap
              ? ` Atingiu limite (${input.max_pages} pág × ${input.page_size}) — pode haver mais.`
              : " Total exato.") +
            (only_open && result.fetchedBeforeOpenFilter !== undefined
              ? ` Filtro only_open: de ${result.fetchedBeforeOpenFilter} buscados, ${result.tickets.length} em aberto.`
              : ""),
        };
      });

      return {
        branches: branchSummaries,
        union_count: unionCount,
        union_exact: branchResults.every(({ result }) => !result.hitCap),
        note: `${branchSummaries.length} branches executadas em paralelo com paginação dual (current+past). union_count = chamados únicos no total (desduplicados por id). Para exportar uma branch, use export_tickets_search_to_excel com o filter correspondente.`,
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
        { filter: input.filter, select: input.select, expand: input.expand },
        { pageSize: input.page_size, maxPages: input.max_pages, onlyOpen: input.only_open },
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
        { filter: input.filter, select: input.select, expand: input.expand },
        { pageSize: input.page_size, maxPages: input.max_pages, onlyOpen: input.only_open },
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
        expand: input.expand,
        orderby: input.orderby,
        top: input.top,
        skip: input.skip,
      });

    case "movidesk_get_persons_in_organizations": {
      // 1. Resolve os identificadores para cod_ref de organização
      const resolvedIds = new Set<string>(input.org_ids as string[]);
      const resolveErrors: string[] = [];

      // Resolve por CNPJ → tenta 3 estratégias em cascata:
      //   1. eq com dígitos puros  (como API pode armazenar)
      //   2. eq com CNPJ formatado (XX.XXX.XXX/XXXX-XX)
      //   3. contains com dígitos  (fallback parcial)
      for (const cnpj of (input.org_cnpjs as string[])) {
        const digits = cnpj.replace(/\D/g, "");
        // Formata como XX.XXX.XXX/XXXX-XX
        const formatted =
          digits.length === 14
            ? `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
            : cnpj;

        let found = false;
        for (const candidate of [digits, formatted, cnpj]) {
          if (found) break;
          try {
            const orgs = await searchPersons({
              filter: `personType eq 2 and cpfCnpj eq '${odataEscape(candidate)}'`,
              select: ["id", "businessName", "cpfCnpj"],
              top: 5,
            });
            if (orgs.length > 0) {
              orgs.forEach((o) => resolvedIds.add(o.id));
              found = true;
            }
          } catch { /* tenta próximo candidato */ }
        }

        // Fallback: contains com os dígitos puros
        if (!found) {
          try {
            const orgs = await searchPersons({
              filter: `personType eq 2 and contains(cpfCnpj,'${odataEscape(digits)}')`,
              select: ["id", "businessName", "cpfCnpj"],
              top: 5,
            });
            if (orgs.length > 0) {
              orgs.forEach((o) => resolvedIds.add(o.id));
              found = true;
            }
          } catch { /* ignora */ }
        }

        if (!found) {
          resolveErrors.push(`CNPJ "${cnpj}" (digits: ${digits}) não encontrou organização (tentativas: eq digits, eq formatado, contains).`);
        }
      }

      // Resolve por razão social → contains(businessName)
      for (const name of (input.org_names as string[])) {
        try {
          const orgs = await searchOrganizationsByName(name, 10);
          if (orgs.length > 0) {
            orgs.forEach((o) => resolvedIds.add(o.id));
          } else {
            resolveErrors.push(`Nome "${name}" não encontrou nenhuma organização.`);
          }
        } catch (e) {
          resolveErrors.push(`Erro ao resolver nome "${name}": ${String(e)}`);
        }
      }

      if (resolvedIds.size === 0) {
        return {
          persons: [],
          matched_count: 0,
          org_ids_resolved: [],
          resolve_errors: resolveErrors,
          note: "Nenhum cod_ref de organização foi resolvido — verifique os identificadores fornecidos.",
        };
      }

      // 2. Busca pessoas via relationships/any(r: r/id eq 'ORG_ID') — filtro confirmado
      const { persons, totalScanned, hitCap } = await getPersonsInOrganizations(
        resolvedIds,
        input.select as string[],
        input.extra_expand as string | undefined,
        input.max_pages as number,
        input.only_active as boolean,
      );

      const MAX_INLINE = 200;
      const activeNote = input.only_active ? " (filtro: isActive eq true)" : "";
      return {
        matched_count: persons.length,
        org_ids_resolved: [...resolvedIds],
        total_scanned: totalScanned,
        hit_cap: hitCap,
        resolve_errors: resolveErrors.length > 0 ? resolveErrors : undefined,
        persons: persons.slice(0, MAX_INLINE),
        persons_truncated: persons.length > MAX_INLINE,
        note:
          `${resolvedIds.size} organização(ões) resolvida(s)${activeNote}. ` +
          `${totalScanned} contato(s) retornado(s) pela API${hitCap ? ` (limite de ${input.max_pages} páginas por org atingido — pode haver mais)` : " (consulta completa)"}. ` +
          `${persons.length} contato(s) únicos encontrado(s).` +
          (persons.length > MAX_INLINE ? ` Só as primeiras ${MAX_INLINE} pessoas aparecem inline.` : "") +
          (resolveErrors.length > 0 ? ` Erros de resolução: ${resolveErrors.join(" | ")}` : ""),
      };
    }

    case "movidesk_search_persons_by_custom_field": {
      const expand = input.extra_expand
        ? `customFieldValues,${input.extra_expand}`
        : "customFieldValues";
      const { persons, pagesFetched, hitCap } = await searchPersonsExhaustive(
        {
          filter: input.base_filter ?? "personType ne 0",
          select: [...new Set([...input.select, "id", "businessName"])],
          expand,
        },
        { maxPages: Math.ceil(input.max_records / 100) },
      );

      const matched = filterByCustomField(
        persons,
        input.custom_field_id,
        input.custom_field_item,
        input.value,
      );

      const MAX_INLINE = 100;
      return {
        matched_count: matched.length,
        total_scanned: persons.length,
        hit_cap: hitCap,
        pages_fetched: pagesFetched,
        persons: matched.slice(0, MAX_INLINE),
        persons_truncated: matched.length > MAX_INLINE,
        note:
          `Varreu ${persons.length} registro(s) em ${pagesFetched} página(s).` +
          (hitCap ? ` Atingiu o limite de max_records=${input.max_records} — pode haver mais resultados. Aumente max_records ou refine base_filter.` : " Varredura completa.") +
          ` Encontrou ${matched.length} registro(s) com customFieldId=${input.custom_field_id}` +
          (input.custom_field_item ? ` e item="${input.custom_field_item}"` : "") +
          (input.value ? ` e value contendo "${input.value}"` : "") +
          "." +
          (matched.length > MAX_INLINE ? ` Só as primeiras ${MAX_INLINE} pessoas aparecem inline.` : ""),
      };
    }

    case "check_pending_customer_tickets": {
      if (!isFollowUpAutomationEnabled()) {
        return {
          results: [],
          note: "FOLLOWUP_AUTOMATION_ENABLED não está 'true' — a automação de cobrança está desligada, nada foi verificado.",
        };
      }
      const results = await runAllFollowUpChecks();
      if (results.length === 0) {
        return { results: [], note: "Nenhum perfil de equipe está habilitado (enabled) no painel — nada foi verificado." };
      }
      return { results };
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
