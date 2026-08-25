import { movideskHttp, type ODataQuery } from "./client.js";

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
