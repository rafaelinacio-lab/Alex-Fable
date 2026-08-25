/**
 * Idempotência (seção 7, Passo E do prompt de sistema).
 *
 * A chave é `conversation_id + flow + requester_id + hash(campos_normalizados)`.
 * Grave a chave ANTES do POST de criação; associe o resultado (ID retornado) depois do
 * sucesso. Isso permite que, após um timeout, o agente confira "já criei isso?" em vez de
 * repetir a criação — regra dura do princípio 2 do prompt ("no máximo uma criação por
 * confirmação").
 *
 * Implementação: arquivo JSON local por chave. Troque por Redis/Postgres com TTL em produção.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export interface IdempotencyRecord {
  key: string;
  createdAt: string;
  status: "pending" | "succeeded" | "failed";
  result?: unknown; // ex: { ticketId: 893181 }
  error?: string;
}

const DEFAULT_DIR = process.env.IDEMPOTENCY_STORE_DIR ?? "./data/idempotency";

export function buildIdempotencyKey(params: {
  conversationId: string;
  flow: string;
  requesterId: string;
  normalizedFields: Record<string, unknown>;
}): string {
  const fieldsHash = createHash("sha256")
    .update(JSON.stringify(params.normalizedFields, Object.keys(params.normalizedFields).sort()))
    .digest("hex")
    .slice(0, 16);
  return `${params.conversationId}:${params.flow}:${params.requesterId}:${fieldsHash}`;
}

function fileFor(key: string, dir: string): string {
  const safe = createHash("sha256").update(key).digest("hex");
  return path.join(dir, `${safe}.json`);
}

export async function idempotencyGet(key: string, dir = DEFAULT_DIR): Promise<IdempotencyRecord | null> {
  try {
    const raw = await readFile(fileFor(key, dir), "utf8");
    return JSON.parse(raw) as IdempotencyRecord;
  } catch {
    return null;
  }
}

export async function idempotencyPut(record: IdempotencyRecord, dir = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(fileFor(record.key, dir), JSON.stringify(record, null, 2), "utf8");
}

/**
 * Marca uma chave como "pending" só se ainda não existir um registro para ela.
 * Retorna o registro existente (se houver) ou o novo registro pending recém-criado.
 * Uso: chamar isto imediatamente antes do POST de criação; se o retorno já tiver
 * status "succeeded", NÃO repita o POST — use o resultado existente.
 */
export async function idempotencyReserve(key: string, dir = DEFAULT_DIR): Promise<IdempotencyRecord> {
  const existing = await idempotencyGet(key, dir);
  if (existing) return existing;
  const record: IdempotencyRecord = { key, createdAt: new Date().toISOString(), status: "pending" };
  await idempotencyPut(record, dir);
  return record;
}
