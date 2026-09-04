import { movideskHttp, odataEscape, type ODataQuery } from "./client.js";

/**
 * Enums confirmados por docs/movidesk-api-tickets.md (seção 15, estrutura de `clients`).
 */
export const PERSON_TYPE = { PESSOA: 1, EMPRESA: 2, DEPARTAMENTO: 4 } as const;
export const PROFILE_TYPE = { AGENTE: 1, CLIENTE: 2, AGENTE_E_CLIENTE: 3 } as const;

export interface Person {
  id: string; // cod_ref alfanumérico
  businessName?: string;
  personType?: number;
  profileType?: number;
  emails?: Array<{ email: string }>;
  organization?: { id: string };
  [key: string]: unknown;
}

/**
 * Segue a mesma convenção confirmada para /tickets (ver docs/movidesk-api-tickets.md):
 * a API do Movidesk identifica o registro via query string (`?id=`), não path REST.
 */
export async function getPerson(id: string): Promise<Person> {
  return movideskHttp.get<Person>("/persons", { extra: { id } });
}

export async function searchPersons(query: ODataQuery): Promise<Person[]> {
  if (!query.select?.length) {
    throw new Error("searchPersons exige $select — nunca liste pessoas sem restringir os campos retornados.");
  }
  return movideskHttp.get<Person[]>("/persons", query);
}

/**
 * Busca organizações diretamente na API real do Movidesk (por nome/razão social),
 * em vez de depender só da lista local sincronizada (`list_customer_organizations`).
 *
 * Filtra por `personType eq 2` (Empresa — enum confirmado em
 * docs/movidesk-api-tickets.md, seção 15) para não misturar pessoas físicas com
 * homônimos no nome. Use isto como fallback quando a organização não aparecer na lista
 * local, ou quando a lista local ainda não tiver sido sincronizada/preenchida.
 */
export async function searchOrganizationsByName(query: string, top = 20): Promise<Person[]> {
  const filter = `personType eq ${PERSON_TYPE.EMPRESA} and contains(businessName,'${odataEscape(query)}')`;
  return searchPersons({
    filter,
    select: ["id", "businessName", "personType", "profileType", "emails"],
    top,
  });
}

export interface PersonsExhaustiveResult {
  persons: Person[];
  pagesFetched: number;
  hitCap: boolean;
}

const DEFAULT_PERSONS_PAGE_SIZE = 100; // API de Persons não confirmou suporte a $top=1000

/**
 * Busca paginada exaustiva de pessoas/organizações.
 * Ao contrário de /tickets, não há rota /persons/past confirmada — uma única fase.
 * pageSize padrão = 100 (conservador; aumente para 500 se a API aceitar).
 */
export async function searchPersonsExhaustive(
  base: Pick<ODataQuery, "filter" | "select" | "expand">,
  opts?: { pageSize?: number; maxPages?: number },
): Promise<PersonsExhaustiveResult> {
  if (!base.select?.length) {
    throw new Error("searchPersonsExhaustive exige select.");
  }
  const pageSize = opts?.pageSize ?? DEFAULT_PERSONS_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? 200;
  const all: Person[] = [];
  let pages = 0;

  for (let skip = 0; ; skip += pageSize) {
    if (pages >= maxPages) return { persons: all, pagesFetched: pages, hitCap: true };
    const page = await searchPersons({ ...base, top: pageSize, skip });
    pages++;
    all.push(...page);
    if (page.length < pageSize) break;
  }

  return { persons: all, pagesFetched: pages, hitCap: false };
}

/**
 * Busca todas as pessoas vinculadas a um conjunto de organizações.
 *
 * Estratégia (confirmada via curl): usa o filtro OData
 *   `relationships/any(r: r/id eq 'ORG_ID')`
 * que é suportado pela API de /persons do Movidesk. Executa uma query direcionada
 * por organização, em lotes paralelos de até CONCURRENCY_LIMIT — muito mais eficiente
 * que a abordagem anterior de varrer todos os contatos e filtrar localmente.
 *
 * `relationships` também é um campo de navegação confirmado: passe-o em `expand` para
 * receber os vínculos completos de cada pessoa retornada.
 *
 * @param orgIds   Set de cod_ref das organizações
 * @param select   Campos da pessoa a retornar
 * @param expand   $expand extra além de "relationships" (que é sempre incluído)
 * @param maxPages Limite de páginas POR ORGANIZAÇÃO (padrão 50 × 100 = até 5 k por org)
 */
const CONCURRENCY_LIMIT = 5;

export async function getPersonsInOrganizations(
  orgIds: Set<string>,
  select: string[],
  expand?: string,
  maxPages = 50,
  onlyActive = false,
): Promise<{ persons: Person[]; totalScanned: number; hitCap: boolean }> {
  if (orgIds.size === 0) return { persons: [], totalScanned: 0, hitCap: false };

  // Garante que relationships esteja no expand para confirmar o vínculo
  const safeExpand = expand
    ? (expand.includes("relationships") ? expand : `relationships,${expand}`)
    : "relationships";

  const orgIdArray = [...orgIds];
  const seen = new Set<string>();
  const allPersons: Person[] = [];
  let totalFromApi = 0;
  let anyHitCap = false;

  // Processa em lotes de CONCURRENCY_LIMIT para não explodir o rate limit (10 req/min)
  for (let i = 0; i < orgIdArray.length; i += CONCURRENCY_LIMIT) {
    const batch = orgIdArray.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.all(
      batch.map((orgId) => {
        const baseFilter = `relationships/any(r: r/id eq '${odataEscape(orgId)}')`;
        const filter = onlyActive ? `${baseFilter} and isActive eq true` : baseFilter;
        return searchPersonsExhaustive(
          { filter, select, expand: safeExpand },
          { maxPages },
        );
      }),
    );

    for (const { persons, hitCap } of results) {
      totalFromApi += persons.length;
      if (hitCap) anyHitCap = true;
      // Deduplica por id — uma pessoa pode aparecer em mais de uma organização
      for (const p of persons) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          allPersons.push(p);
        }
      }
    }
  }

  // totalScanned = total retornado pela API antes da deduplicação
  return { persons: allPersons, totalScanned: totalFromApi, hitCap: anyHitCap };
}

/**
 * Filtra localmente por um campo adicional (customFieldValues).
 * Usar após buscar com $expand=customFieldValues.
 *
 * @param persons   Array retornado pela API com customFieldValues expandido
 * @param fieldId   ID do campo (ex: 29433 para "Vertical Viasoft:")
 * @param item      Valor esperado em items[].customFieldItem (para lista/seleção)
 * @param value     Valor esperado em value (para texto/data/numérico)
 */
export function filterByCustomField(
  persons: Person[],
  fieldId: number,
  item?: string,
  value?: string,
): Person[] {
  return persons.filter((p) => {
    const cfv = p.customFieldValues;
    if (!Array.isArray(cfv)) return false;
    return cfv.some((cf: Record<string, unknown>) => {
      if (cf.customFieldId !== fieldId) return false;
      if (item !== undefined) {
        const items = cf.items;
        if (!Array.isArray(items)) return false;
        return items.some((i: Record<string, unknown>) => {
          const fi = String(i.customFieldItem ?? "").toLowerCase();
          return fi.includes(item.toLowerCase());
        });
      }
      if (value !== undefined) {
        return String(cf.value ?? "").toLowerCase().includes(value.toLowerCase());
      }
      // Sem filtro de valor — basta o campo existir preenchido
      return cf.value !== null && cf.value !== undefined && cf.value !== "" ||
        (Array.isArray(cf.items) && cf.items.length > 0);
    });
  });
}
