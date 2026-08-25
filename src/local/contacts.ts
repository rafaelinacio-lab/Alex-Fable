/**
 * Diretório local `movidesk_contatos` (e-mail -> cod_ref) e organizações sincronizadas.
 *
 * Implementação de referência: arquivo JSON local. Em produção, troque a leitura por uma
 * consulta real ao banco/planilha sincronizada com o Movidesk — mantendo as mesmas
 * assinaturas (`findContactByEmail`, `listOrganizations`) para não precisar mudar o
 * contrato de ferramentas do agente.
 */

import { readFile } from "node:fs/promises";

export interface LocalContact {
  cod_ref: string;
  name: string;
  email: string;
  department?: string;
}

export interface LocalOrganization {
  cod_ref: string;
  business_name: string;
  cnpj?: string;
}

const CONTACTS_FILE = process.env.LOCAL_CONTACTS_FILE ?? "./data/local/movidesk_contatos.json";
const ORGANIZATIONS_FILE = process.env.LOCAL_ORGANIZATIONS_FILE ?? "./data/local/organizacoes.json";

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function findContactByEmail(email: string): Promise<LocalContact | null> {
  const normalized = email.trim().toLowerCase();
  const contacts = await readJsonArray<LocalContact>(CONTACTS_FILE);
  return contacts.find((c) => c.email.trim().toLowerCase() === normalized) ?? null;
}

export async function listOrganizations(query: string, limit = 10): Promise<LocalOrganization[]> {
  const q = query.trim().toLowerCase();
  const orgs = await readJsonArray<LocalOrganization>(ORGANIZATIONS_FILE);
  const filtered = q
    ? orgs.filter(
        (o) => o.business_name.toLowerCase().includes(q) || o.cnpj?.replace(/\D/g, "").includes(q.replace(/\D/g, "")),
      )
    : orgs;
  return filtered.slice(0, limit);
}
