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
}

/** Escapa uma string para uso seguro dentro de um filtro OData (aspas simples dobradas). */
export function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function buildQueryString(query: ODataQuery): string {
  const params = new URLSearchParams();
  if (query.filter) params.set("$filter", query.filter);
  if (query.select?.length) params.set("$select", query.select.join(","));
  if (query.orderby) params.set("$orderby", query.orderby);
  if (query.top !== undefined) params.set("$top", String(query.top));
  if (query.skip !== undefined) params.set("$skip", String(query.skip));
  if (query.expand) params.set("$expand", query.expand);
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

  const maxAttempts = opts.retryOnServerError ? 3 : 1;
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
      const retryAfterHeader = response.headers.get("Retry-After");
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : backoffWithJitter(attempt);
      if (attempt < maxAttempts - 1) {
        await sleep(waitMs);
        continue;
      }
      throw new MovideskApiError("Limite de requisições excedido (429).", 429);
    }

    if (response.status >= 500) {
      if (opts.retryOnServerError && attempt < maxAttempts - 1) {
        await sleep(backoffWithJitter(attempt));
        continue;
      }
      throw new MovideskApiError(`Erro no servidor Movidesk (${response.status}).`, response.status);
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
    return (await response.json()) as T;
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
