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
