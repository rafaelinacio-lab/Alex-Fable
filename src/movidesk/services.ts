import { movideskHttp, type ODataQuery } from "./client.js";

export interface MovideskService {
  id: number;
  name?: string;
  defaultCategory?: string;
  allowedCategories?: string[];
  defaultUrgency?: string;
  [key: string]: unknown;
}

/**
 * Segue a mesma convenção confirmada para /tickets (ver docs/movidesk-api-tickets.md):
 * a API do Movidesk identifica o registro via query string (`?id=`), não path REST.
 */
export async function getService(id: number): Promise<MovideskService> {
  return movideskHttp.get<MovideskService>("/services", { extra: { id } });
}

export async function searchServices(query: ODataQuery): Promise<MovideskService[]> {
  if (!query.select?.length) {
    throw new Error("searchServices exige $select — nunca liste serviços sem restringir os campos retornados.");
  }
  return movideskHttp.get<MovideskService[]>("/services", query);
}
