import { movideskHttp, odataEscape, type ODataQuery } from "./client.js";

export interface Person {
  id: string; // cod_ref alfanumérico
  businessName?: string;
  personType?: number;
  profileType?: number;
  emails?: Array<{ email: string }>;
  [key: string]: unknown;
}

export async function getPerson(id: string): Promise<Person> {
  return movideskHttp.get<Person>(`/persons/${encodeURIComponent(id)}`);
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
 * Não filtra por `personType`/`profileType` porque o valor exato desses enums não está
 * confirmado neste tenant (ver seção 2 do prompt: "nunca invente...") — devolve os
 * resultados crus e deixa o agente/UI decidir com base nos campos retornados. Use isto
 * como fallback quando a organização não aparecer na lista local, ou quando a lista
 * local ainda não tiver sido sincronizada/preenchida.
 */
export async function searchOrganizationsByName(query: string, top = 20): Promise<Person[]> {
  const filter = `contains(businessName,'${odataEscape(query)}')`;
  return searchPersons({
    filter,
    select: ["id", "businessName", "personType", "profileType", "emails"],
    top,
  });
}
