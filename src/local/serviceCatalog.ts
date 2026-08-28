/**
 * Catálogo local de serviços (primeiro nível) do Movidesk, sincronizado a partir da
 * exportação oficial (Configurações > Serviços) em `data/local/servicos.json`.
 *
 * Existe porque a busca de serviços direto na API (`movidesk_search_services` por nome)
 * é ambígua neste tenant: pode haver múltiplos serviços com nomes iguais/parecidos e IDs
 * diferentes (ex: "Construshow" apareceu 5 vezes numa busca real, cada um com um ID). O
 * catálogo local é a fonte mais confiável para resolver nome → id/serviceFull ANTES de
 * montar um filtro de busca de chamados.
 *
 * O campo `servico` aqui é a trilha textual (ex: "GCC » Agronegócio") — é exatamente o
 * texto usado no filtro confirmado `serviceFull/any(s: s eq 'Nome do Serviço')` (ver
 * seção "Serviços, categoria e equipe" do prompt de sistema).
 *
 * Este arquivo cobre só os serviços de PRIMEIRO NÍVEL cadastrados no momento da
 * exportação — pode não incluir sub-serviços/variações de nível 2-3. Se a busca aqui não
 * encontrar nada, caia para `movidesk_search_services` contra a API real.
 */

import { readFile } from "node:fs/promises";

export interface KnownService {
  id: number;
  /** Trilha textual completa (ex: "GCC » Agronegócio") — usar em filtros serviceFull. */
  servico: string;
  nome: string;
  descricao: string;
  disponivelParaTickets: string;
  ativo: boolean;
}

const CATALOG_FILE = process.env.LOCAL_SERVICES_FILE ?? "./data/local/servicos.json";

let cache: KnownService[] | null = null;

async function loadCatalog(): Promise<KnownService[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(CATALOG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as KnownService[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = [];
    } else {
      throw err;
    }
  }
  return cache;
}

export async function searchKnownServices(query: string, limit = 10): Promise<KnownService[]> {
  const catalog = await loadCatalog();
  const q = query.trim().toLowerCase();
  const filtered = q
    ? catalog.filter((s) => s.servico.toLowerCase().includes(q) || s.nome.toLowerCase().includes(q))
    : catalog;
  return filtered.slice(0, limit);
}

export async function getKnownServiceById(id: number): Promise<KnownService | null> {
  const catalog = await loadCatalog();
  return catalog.find((s) => s.id === id) ?? null;
}
