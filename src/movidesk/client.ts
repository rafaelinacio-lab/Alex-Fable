/**
 * Cliente HTTP para a API pública do Movidesk.
 *
 * ESTE é o único módulo que lê `MOVIDESK_TOKEN` do ambiente. O agente (LLM) nunca recebe
 * o token — ele só chama funções tipadas (ver ../agent/tools.ts) que, por baixo, usam este
 * cliente. Nunca logue o token nem o inclua em mensagens de erro devolvidas ao modelo.
 */

import { RateLimiter, backoffWithJitter, sleep } from "../store/rateLimiter.js";
import { emitEvent, newEventId } from "../observability/eventBus.js";

const BASE_URL = process.env.MOVIDESK_BASE_URL ?? "https://api.movidesk.com/public/v1";
const TOKEN = process.env.MOVIDESK_TOKEN;

const rateLimiter = new RateLimiter();

export class MovideskApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly propertyName?: string,
    public readonly body?: unknown,
    public readonly correlationId?: string,
    /** Presente em 429: segundos até novas requisições serem permitidas (header Retry-After). */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MovideskApiError";
  }
}

export interface ODataQuery {
  filter?: string;
  select?: string[];
  orderby?: string;
  top?: number;
  skip?: number;
  expand?: string;
  /**
   * Parâmetros extras fora do padrão OData — a API do Movidesk usa query string também
   * para coisas como `id`, `protocol`, `actionId`, `returnAllProperties`,
   * `includeDeletedItems` (ver docs/movidesk-api-tickets.md). NÃO existe endpoint
   * REST por path (`/tickets/123`) — é sempre `/tickets?id=123`.
   */
  extra?: Record<string, string | number | boolean>;
}

/** Escapa uma string para uso seguro dentro de um filtro OData (aspas simples dobradas). */
export function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildQueryString(query: ODataQuery): string {
  const params = new URLSearchParams();
  if (query.filter) params.set("$filter", query.filter);
  if (query.select?.length) params.set("$select", query.select.join(","));
  if (query.orderby) params.set("$orderby", query.orderby);
  if (query.top !== undefined) params.set("$top", String(query.top));
  if (query.skip !== undefined) params.set("$skip", String(query.skip));
  if (query.expand) params.set("$expand", query.expand);
  if (query.extra) {
    for (const [key, value] of Object.entries(query.extra)) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: ODataQuery;
  body?: unknown;
  /** GETs podem repetir em 5xx/timeout; mutações (POST/PATCH) nunca repetem sozinhas aqui. */
  retryOnServerError?: boolean;
}

/**
 * Envolve `requestInner` para publicar eventos de observabilidade (dashboard) sem tocar
 * a lógica de retry/backoff. A URL/query publicada NUNCA inclui o token — só método,
 * caminho e a query string OData (que já não contém segredos).
 */
async function request<T>(opts: RequestOptions): Promise<T> {
  const id = newEventId();
  const qsForDisplay = opts.query ? buildQueryString(opts.query) : "";
  const start = Date.now();
  emitEvent({
    kind: "api_call_start",
    id,
    timestamp: new Date().toISOString(),
    method: opts.method,
    path: opts.path,
    query: qsForDisplay || undefined,
  });
  try {
    const result = await requestInner<T>(opts);
    emitEvent({
      kind: "api_call_end",
      id,
      timestamp: new Date().toISOString(),
      method: opts.method,
      path: opts.path,
      status: "ok",
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    emitEvent({
      kind: "api_call_end",
      id,
      timestamp: new Date().toISOString(),
      method: opts.method,
      path: opts.path,
      status: "error",
      httpStatus: err instanceof MovideskApiError ? err.status : undefined,
      durationMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAfterSeconds: err instanceof MovideskApiError ? err.retryAfterSeconds : undefined,
    });
    throw err;
  }
}

async function requestInner<T>(opts: RequestOptions): Promise<T> {
  if (!TOKEN) {
    throw new Error(
      "MOVIDESK_TOKEN não configurado. Configure a variável de ambiente antes de usar o cliente Movidesk.",
    );
  }

  const qs = opts.query ? buildQueryString(opts.query) : "";
  const separator = qs ? "?" : "";
  const url = `${BASE_URL}${opts.path}${separator}${qs}${qs ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;

  // IMPORTANTE: cada tentativa é uma requisição real ao Movidesk, e a própria API conta
  // requisições com erro para o bloqueio escalonado documentado (3 erros seguidos -> 60s,
  // +3 -> 120s, +3 -> 300s — ver docs/movidesk-api-tickets.md, seção 3). Um valor alto
  // aqui faz uma ÚNICA chamada de ferramenta já consumir sozinha o "orçamento" de falhas
  // e travar o agente antes mesmo dele conseguir avisar o usuário. Por isso o máximo é 2
  // (1 tentativa original + 1 retry), não 3.
  const maxAttempts = opts.retryOnServerError ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await rateLimiter.acquire();

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (networkError) {
      lastError = networkError;
      if (attempt < maxAttempts - 1) {
        await sleep(backoffWithJitter(attempt));
        continue;
      }
      throw new Error(`Falha de rede ao chamar Movidesk (${opts.method} ${opts.path}): ${String(networkError)}`);
    }

    if (response.status === 429) {
      // Documentado (docs/movidesk-api-tickets.md, seção 3): após 3 requisições com erro
      // seguidas, a API bloqueia por 60s; mais 3 erros -> 120s; mais 3 -> 300s. NUNCA
      // retry automático aqui: dormir o Retry-After (pode ser até 300s) dentro de uma
      // chamada de ferramenta travaria a conversa inteira por minutos, e mandar mais uma
      // requisição enquanto o bloqueio ainda vale só piora a situação. Falha imediato e
      // devolve o tempo de espera para quem chamou decidir o que fazer.
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      // O texto da mensagem inclui o tempo de espera diretamente porque é isto que chega
      // até o modelo (o orquestrador propaga err.message como resultado da ferramenta) —
      // sem isso o agente não tem como saber quanto tempo esperar antes de tentar de novo.
      const waitInfo =
        retryAfterSeconds !== undefined
          ? ` Aguarde ${retryAfterSeconds} segundos antes de tentar de novo — NÃO tente antes disso, cada tentativa dentro do bloqueio piora/renova o tempo de espera.`
          : " Aguarde antes de tentar de novo.";
      throw new MovideskApiError(
        `Limite de requisições excedido (429 - Too many failed requests).${waitInfo}`,
        429,
        undefined,
        undefined,
        undefined,
        retryAfterSeconds,
      );
    }

    if (response.status >= 500) {
      // Lê o corpo mesmo em 5xx — às vezes o Movidesk devolve detalhe útil, e sem isso
      // não há como diagnosticar por que um endpoint específico (ex: /tickets/past) está
      // falhando de forma consistente.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      if (opts.retryOnServerError && attempt < maxAttempts - 1) {
        await sleep(backoffWithJitter(attempt));
        continue;
      }
      // O corpo entra na mensagem (truncado) porque é isto que chega até o modelo — sem
      // isso um 500 persistente em um endpoint específico (ex: /tickets/past) não tem
      // como ser diagnosticado, só "deu erro" repetido.
      const bodyText = typeof body === "string" ? body : JSON.stringify(body);
      const bodySnippet = bodyText && bodyText !== "{}" ? ` Corpo: ${bodyText.slice(0, 500)}` : "";
      throw new MovideskApiError(
        `Erro no servidor Movidesk (${response.status}) em ${opts.method} ${opts.path}.${bodySnippet}`,
        response.status,
        undefined,
        body,
      );
    }

    const correlationId = response.headers.get("x-correlation-id") ?? undefined;

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      const propertyName =
        body && typeof body === "object" && "propertyName" in body
          ? String((body as Record<string, unknown>).propertyName)
          : undefined;
      const errorMessage =
        body && typeof body === "object" && "errorMessage" in body
          ? String((body as Record<string, unknown>).errorMessage)
          : `Erro ${response.status} do Movidesk`;
      throw new MovideskApiError(errorMessage, response.status, propertyName, body, correlationId);
    }

    if (response.status === 204) return undefined as T;

    // IMPORTANTE (confirmado ao vivo em PATCH /tickets): o Movidesk pode devolver 200
    // com corpo VAZIO em vez de 204 — response.json() numa string vazia lança
    // "Unexpected end of JSON input" DEPOIS que a mutação já foi aplicada com sucesso no
    // servidor. Sem isso, uma cobrança automática (ou qualquer PATCH) aparecia como erro
    // no painel mesmo já tendo sido enviada de verdade ao ticket — o pior tipo de falso
    // negativo, porque parece seguro tentar de novo quando não é. Lemos como texto
    // primeiro e só tentamos JSON se houver conteúdo; corpo vazio = sucesso sem dados.
    const rawText = await response.text();
    if (!rawText) return undefined as T;
    try {
      return JSON.parse(rawText) as T;
    } catch {
      throw new Error(
        `Resposta ${response.status} do Movidesk em ${opts.method} ${opts.path} não é JSON válido (a operação pode já ter sido aplicada no servidor). Corpo: ${rawText.slice(0, 500)}`,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Falha desconhecida ao chamar Movidesk.");
}

export const movideskHttp = {
  get: <T>(path: string, query?: ODataQuery) => request<T>({ method: "GET", path, query, retryOnServerError: true }),
  post: <T>(path: string, body: unknown, query?: ODataQuery) =>
    request<T>({ method: "POST", path, body, query, retryOnServerError: false }),
  patch: <T>(path: string, body: unknown, query?: ODataQuery) =>
    request<T>({ method: "PATCH", path, body, query, retryOnServerError: false }),
};
