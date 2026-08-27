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
  ownerTeam?: string;
  serviceFirstLevelId?: number;
  category?: string;
  [key: string]: unknown;
}

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
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;

/**
 * Percorre TODAS as páginas de uma busca (via `$skip`) até a API devolver uma página
 * menor que o tamanho pedido (fim real dos resultados) ou até atingir `maxPages` (limite
 * de segurança, evita loop descontrolado / estourar o rate limit). A API do Movidesk não
 * suporta `$count` (seção 6 da doc) — esta é a única forma de saber um total exato.
 *
 * Isto é uma sequência de GETs — não precisa de confirmação do usuário nem de pausas
 * entre páginas (seção 3 do prompt de sistema: consultas GET podem ser executadas sem
 * nova confirmação). O tempo total é limitado pelo rate limit (10 req/min por padrão):
 * `maxPages=50` com `pageSize=100` pode levar até ~5 minutos para 5.000 registros — isso
 * é esperado, não é motivo para parar e perguntar se deve continuar.
 *
 * `hitCap: true` no retorno significa que o total pode ser MAIOR do que o array
 * devolvido — nunca reporte esse número como "total" sem deixar isso claro.
 */
export async function searchTicketsExhaustive(
  base: Pick<ODataQuery, "filter" | "select">,
  opts?: { pageSize?: number; maxPages?: number; source?: "current" | "past" },
): Promise<ExhaustiveSearchResult> {
  if (!base.select?.length) {
    throw new Error("searchTicketsExhaustive exige select — nunca liste tickets sem restringir os campos retornados.");
  }
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const fetchPage = opts?.source === "past" ? searchTicketsPast : searchTickets;
  // orderby por id garante que $skip não pule/repita registros entre páginas.
  const orderby = "id asc";

  const all: TicketSummary[] = [];
  for (let page = 0; page < maxPages; page++) {
    const pageResults = await fetchPage({ ...base, orderby, top: pageSize, skip: page * pageSize });
    all.push(...pageResults);
    if (pageResults.length < pageSize) {
      return { tickets: all, pagesFetched: page + 1, hitCap: false };
    }
  }
  return { tickets: all, pagesFetched: maxPages, hitCap: true };
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
