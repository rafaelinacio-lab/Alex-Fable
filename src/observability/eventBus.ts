/**
 * Barramento de eventos de observabilidade do agente.
 *
 * Toda chamada de ferramenta (`src/agent/tools.ts`) e toda chamada HTTP ao Movidesk
 * (`src/movidesk/client.ts`) publica eventos aqui. O dashboard (`src/server/dashboard.ts`)
 * escuta esses eventos e transmite para o navegador via WebSocket.
 *
 * Regra de segurança: nada que passa por este barramento pode conter token, senha,
 * cookie ou cabeçalho de autenticação — `sanitizeForDashboard` redige campos sensíveis
 * conhecidos e trunca valores grandes antes de qualquer coisa ser emitida.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type AgentEvent =
  | { kind: "tool_call_start"; id: string; timestamp: string; tool: string; input: unknown }
  | {
      kind: "tool_call_end";
      id: string;
      timestamp: string;
      tool: string;
      status: "ok" | "error";
      durationMs: number;
      output?: unknown;
      error?: string;
    }
  | { kind: "api_call_start"; id: string; timestamp: string; method: string; path: string; query?: string }
  | {
      kind: "api_call_end";
      id: string;
      timestamp: string;
      method: string;
      path: string;
      status: "ok" | "error";
      httpStatus?: number;
      durationMs: number;
      errorMessage?: string;
    };

export const agentEventBus = new EventEmitter();
agentEventBus.setMaxListeners(50);

export function emitEvent(event: AgentEvent): void {
  agentEventBus.emit("event", event);
}

export function newEventId(): string {
  return randomUUID();
}

const SENSITIVE_KEYS = new Set([
  "token",
  "authorization",
  "cookie",
  "password",
  "senha",
  "secret",
  "apikey",
  "api_key",
  "cpf",
  "cnpj",
  "telefone",
  "phone",
  "email",
]);

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 10;

/**
 * Prepara qualquer valor (input/output de ferramenta) para ir ao dashboard: mascara
 * chaves sensíveis conhecidas, trunca strings e arrays grandes, e limita profundidade —
 * o dashboard é para acompanhamento visual, não é o log de auditoria completo.
 */
export function sanitizeForDashboard(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[…]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeForDashboard(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`… +${value.length - MAX_ARRAY_ITEMS} itens`);
    return items;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = "[redigido]";
        continue;
      }
      out[key] = sanitizeForDashboard(v, depth + 1);
    }
    return out;
  }

  return String(value);
}
