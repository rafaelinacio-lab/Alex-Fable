/**
 * Auditoria (seção 10 do prompt de sistema).
 *
 * Toda mutação deve ser registrada aqui ANTES e DEPOIS da chamada real, sem nunca
 * incluir segredos (tokens, senhas, cookies, cabeçalhos completos) nem dados pessoais
 * além do necessário para rastrear a operação.
 *
 * Implementação: append-only JSONL local. Troque por um sink real (Postgres, um serviço
 * de log estruturado, etc.) mantendo a mesma assinatura de `recordAuditEvent`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface AuditEvent {
  timestamp: string; // ISO-8601 com fuso
  authenticatedUser: { id_local: string; email: string };
  intent: string;
  operation: string; // ex: "movidesk_patch_ticket"
  endpoint: string; // endpoint lógico, ex: "PATCH /tickets"
  targetId?: string | number;
  payloadHash?: string; // hash do payload normalizado, nunca o payload cru com PII desnecessária
  changedFields?: string[];
  httpStatus?: number;
  returnedId?: string | number;
  verified?: boolean;
  correlationId: string;
  errorCode?: string;
}

const DEFAULT_DIR = process.env.AUDIT_STORE_DIR ?? "./data/audit";

const FORBIDDEN_KEYS = new Set(["token", "authorization", "cookie", "password", "secret", "apikey", "api_key"]);

/** Garante que nenhuma chave sensível vaze para o log de auditoria. */
function assertNoSecrets(event: AuditEvent): void {
  const raw = JSON.stringify(event).toLowerCase();
  for (const key of FORBIDDEN_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error(
        `Tentativa de registrar auditoria contendo chave sensível "${key}". Bloqueado por segurança.`,
      );
    }
  }
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function newCorrelationId(): string {
  return randomUUID();
}

export async function recordAuditEvent(event: AuditEvent, dir = DEFAULT_DIR): Promise<void> {
  assertNoSecrets(event);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${event.timestamp.slice(0, 10)}.jsonl`);
  await appendFile(file, JSON.stringify(event) + "\n", "utf8");
}
