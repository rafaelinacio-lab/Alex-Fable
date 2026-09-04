import { movideskHttp, type ODataQuery } from "./client.js";

export interface TicketClientRef {
  id: string;
  isRequester?: boolean;
}

export interface TicketCustomFieldValue {
  customFieldId: number;
  customFieldRuleId: number;
  line: number;
  value?: string | number | null;
  items?: Array<{
    personId?: string;
    clientId?: string;
    team?: string;
    customFieldItem?: string;
  }>;
}

export interface TicketAction {
  type: number;
  createdBy: { id: string };
  description: string;
}

/** Forma de uma ação já existente, como devolvida pela API (via $expand=actions). */
export interface TicketActionSummary {
  id?: number;
  type?: number;
  createdBy?: { id: string; businessName?: string };
  createdDate?: string;
  description?: string;
  [key: string]: unknown;
}

/** Entrada de statusHistories (docs/movidesk-api-tickets.md, seção 22). */
export interface TicketStatusHistoryEntry {
  status?: string;
  justification?: string;
  changedBy?: { id: string; businessName?: string };
  changedDate?: string;
  [key: string]: unknown;
}

export interface CreateTicketPayload {
  type: number;
  origin: number;
  subject: string;
  status: string;
  ownerTeam: string;
  serviceFirstLevelId: number;
  serviceFull: string[];
  /** Omitir esta propriedade quando o fluxo confirmado exigir (ver src/config/tenant.ts). */
  category?: string;
  contactForm?: string;
  createdBy: { id: string };
  clients: TicketClientRef[];
  actions?: TicketAction[];
  customFieldValues?: TicketCustomFieldValue[];
}

export interface PatchTicketPayload {
  status?: string;
  justification?: string | null;
  ownerTeam?: string;
  owner?: { id: string };
  category?: string;
  urgency?: string;
  subject?: string;
  /** Lista completa desejada — enviar substitui (nunca faz merge) a lista existente. */
  tags?: string[];
  actions?: TicketAction[];
  customFieldValues?: TicketCustomFieldValue[];
  [key: string]: unknown;
}

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  /**
   * Motivo específico de por que o chamado está no status atual — em muitos tenants
   * (confirmado em produção real, ver src/agent/followUp.ts) o `status` em si é genérico
   * (ex: "Aguardando") e é o `justification` que diz a razão (ex: "Validação Cliente",
   * "Retorno Cliente"). Não assuma que o `status` sozinho descreve a situação.
   */
  justification?: string | null;
  baseStatus?: string;
  ownerTeam?: string;
  owner?: { id: string; businessName?: string };
  serviceFirstLevelId?: number;
  category?: string;
  /** Presente só quando a busca usa $expand=actions. */
  actions?: TicketActionSummary[];
  /** Presente só quando a busca usa $expand=statusHistories. */
  statusHistories?: TicketStatusHistoryEntry[];
  [key: string]: unknown;
}

/**
 * Enum confirmado (docs/movidesk-api-tickets.md, seção 12.1) — `baseStatus` é a
 * classificação canônica do ticket, diferente de `status` (o texto do status
 * configurado no tenant, ex: "Aguardando", "Em Análise" — pode variar e não é
 * confiável para decidir se um chamado está "aberto" ou não).
 */
export const BASE_STATUS = {
  NOVO: "New",
  EM_ATENDIMENTO: "InAttendance",
  PARADO: "Stopped",
  CANCELADO: "Canceled",
  RESOLVIDO: "Resolved",
  FECHADO: "Closed",
} as const;

/** "Em aberto" = não resolvido, não cancelado, não fechado. */
export const OPEN_BASE_STATUSES: readonly string[] = [
  BASE_STATUS.NOVO,
  BASE_STATUS.EM_ATENDIMENTO,
  BASE_STATUS.PARADO,
];

const MAX_SUBJECT_LENGTH = 128;

export function validateSubject(subject: string): string {
  if (!subject.trim()) throw new Error("Assunto do chamado não pode ser vazio.");
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`Assunto excede ${MAX_SUBJECT_LENGTH} caracteres (tem ${subject.length}).`);
  }
  return subject;
}

/** Escapa texto do usuário antes de embutir em HTML de uma ação/descrição. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * IMPORTANTE: a API do Movidesk NÃO usa `/tickets/{id}` (path). O ticket é sempre
 * identificado via query string: `GET /tickets?id=123` ou `GET /tickets?protocol=...`
 * (ver docs/movidesk-api-tickets.md, seção 4). O mesmo vale para PATCH.
 */
export async function getTicket(id: number, select?: string[], expand?: string): Promise<TicketSummary> {
  return movideskHttp.get<TicketSummary>("/tickets", { select, expand, extra: { id } });
}

export async function getTicketByProtocol(protocol: string, select?: string[], expand?: string): Promise<TicketSummary> {
  return movideskHttp.get<TicketSummary>("/tickets", { select, expand, extra: { protocol } });
}

/** HTML de uma ação específica (o campo `description` normal só traz texto). */
export async function getTicketActionHtml(
  ref: { id: number } | { protocol: string },
  actionId?: number,
): Promise<{ id: number; description: string }> {
  const extra: Record<string, string | number> = "id" in ref ? { id: ref.id } : { protocol: ref.protocol };
  if (actionId !== undefined) extra.actionId = actionId;
  return movideskHttp.get<{ id: number; description: string }>("/tickets/htmldescription", { extra });
}

export async function searchTickets(query: ODataQuery): Promise<TicketSummary[]> {
  if (!query.select?.length) {
    throw new Error("searchTickets exige $select — nunca liste tickets sem restringir os campos retornados.");
  }
  return movideskHttp.get<TicketSummary[]>("/tickets", query);
}

/**
 * `/tickets` só cobre tickets com `lastUpdate` há menos de 90 dias (ver
 * docs/movidesk-api-tickets.md, seção 11). Para tickets mais antigos, use esta rota.
 * A sintaxe exata de `/tickets/past` não foi detalhada na documentação disponível — os
 * mesmos parâmetros OData de `/tickets` são assumidos por analogia, mas não estão
 * confirmados; se a API responder de forma inesperada, trate como comportamento não
 * documentado (seção 9) em vez de insistir.
 */
export async function searchTicketsPast(query: ODataQuery): Promise<TicketSummary[]> {
  if (!query.select?.length) {
    throw new Error("searchTicketsPast exige $select — nunca liste tickets sem restringir os campos retornados.");
  }
  return movideskHttp.get<TicketSummary[]>("/tickets/past", query);
}

export interface ExhaustiveSearchResult {
  tickets: TicketSummary[];
  pagesFetched: number;
  /** true = paginação foi interrompida pelo limite de segurança, não porque acabaram os resultados. */
  hitCap: boolean;
  /** Quantos registros vieram da API antes do filtro local de onlyOpen (se usado). */
  fetchedBeforeOpenFilter?: number;
  /** Fases percorridas na paginação dual. */
  phasesCompleted: Array<"current" | "past">;
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;

/**
 * Busca exaustiva padrão — percorre AMBAS as rotas da API em sequência, exatamente
 * como o fluxo n8n de referência (Abertos / Fechados no Movidesk):
 *
 *   Fase 1 → /tickets       (chamados com lastUpdate nos últimos 90 dias)
 *   Fase 2 → /tickets/past  (chamados mais antigos, mesmo filtro OData)
 *
 * Cada fase pagina via $skip até a API retornar uma página menor que `pageSize`
 * (sinal de fim real). O limite `maxPages` é de segurança global (soma das duas fases)
 * para evitar loop descontrolado em caso de bug no filtro.
 *
 * Por que duas fases?
 *   O Movidesk divide o acervo histórico em duas rotas sem aviso explícito. Uma busca
 *   que só use /tickets perde silenciosamente todos os chamados mais antigos; uma busca
 *   que só use /tickets/past perde os recentes. A única forma de garantir cobertura
 *   total é passar pelas duas.
 *
 * Por que pageSize=1000?
 *   O n8n de referência usa $top=1000 — o maior lote confirmado pela API. Menos
 *   requisições significam menos consumo do rate limit (10 req/min).
 *
 * `hitCap: true` → total pode ser MAIOR que o array devolvido; nunca reporte como exato.
 *
 * `onlyOpen`: filtra "chamados em aberto" (baseStatus ∈ New/InAttendance/Stopped) APÓS
 *   buscar, no código — não via $filter OData. Os operadores ne/or/not não estão
 *   confirmados nesta API, então montá-los arriscaria falsos positivos silenciosos.
 */
export async function searchTicketsExhaustive(
  base: Pick<ODataQuery, "filter" | "select" | "expand">,
  opts?: { pageSize?: number; maxPages?: number; onlyOpen?: boolean },
): Promise<ExhaustiveSearchResult> {
  if (!base.select?.length) {
    throw new Error("searchTicketsExhaustive exige select — nunca liste tickets sem restringir os campos retornados.");
  }

  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  // orderby por id garante estabilidade da paginação — $skip não pula/repete registros.
  const orderby = "id asc";
  // Garante que baseStatus esteja presente quando for filtrar por ele localmente.
  const select =
    opts?.onlyOpen && !base.select.includes("baseStatus") ? [...base.select, "baseStatus"] : base.select;

  const all: TicketSummary[] = [];
  let totalPages = 0;
  const phasesCompleted: Array<"current" | "past"> = [];

  // Fase 1 — /tickets (recentes)
  for (let skip = 0; ; skip += pageSize) {
    if (totalPages >= maxPages) {
      return finishExhaustive(all, totalPages, true, opts?.onlyOpen, phasesCompleted);
    }
    const page = await searchTickets({ ...base, select, orderby, top: pageSize, skip });
    totalPages++;
    all.push(...page);
    if (page.length < pageSize) {
      phasesCompleted.push("current");
      break;
    }
  }

  // Fase 2 — /tickets/past (histórico > 90 dias)
  for (let skip = 0; ; skip += pageSize) {
    if (totalPages >= maxPages) {
      return finishExhaustive(all, totalPages, true, opts?.onlyOpen, phasesCompleted);
    }
    const page = await searchTicketsPast({ ...base, select, orderby, top: pageSize, skip });
    totalPages++;
    all.push(...page);
    if (page.length < pageSize) {
      phasesCompleted.push("past");
      break;
    }
  }

  return finishExhaustive(all, totalPages, false, opts?.onlyOpen, phasesCompleted);
}

function finishExhaustive(
  all: TicketSummary[],
  pagesFetched: number,
  hitCap: boolean,
  onlyOpen: boolean | undefined,
  phasesCompleted: Array<"current" | "past">,
): ExhaustiveSearchResult {
  if (!onlyOpen) {
    return { tickets: all, pagesFetched, hitCap, phasesCompleted };
  }
  const filtered = all.filter((t) => typeof t.baseStatus === "string" && OPEN_BASE_STATUSES.includes(t.baseStatus));
  return { tickets: filtered, pagesFetched, hitCap, phasesCompleted, fetchedBeforeOpenFilter: all.length };
}

export async function createTicket(
  payload: CreateTicketPayload,
  returnAllProperties = false,
): Promise<{ id: number }> {
  validateSubject(payload.subject);
  const hasRequester = payload.clients.some((c) => c.isRequester);
  if (!hasRequester) {
    throw new Error("O solicitante deve aparecer em clients com isRequester: true.");
  }
  return movideskHttp.post<{ id: number }>("/tickets", payload, { extra: { returnAllProperties } });
}

export async function patchTicket(id: number, payload: PatchTicketPayload): Promise<TicketSummary> {
  if ("status" in payload && !("justification" in payload)) {
    throw new Error(
      'Alterar "status" exige enviar "justification" junto (mesmo que null) — ' +
        'caso contrário a API responde "Update both Status and Reason".',
    );
  }
  return movideskHttp.patch<TicketSummary>("/tickets", payload, { extra: { id } });
}
