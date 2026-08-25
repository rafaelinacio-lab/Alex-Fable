import { movideskHttp, type ODataQuery } from "./client.js";

export interface TicketClientRef {
  id: string;
  isRequester?: boolean;
}

export interface TicketCustomFieldValue {
  customFieldId: number;
  customFieldRuleId: number;
  line: number;
  value?: string | number | null;
  items?: Array<{
    personId?: string;
    clientId?: string;
    team?: string;
    customFieldItem?: string;
  }>;
}

export interface TicketAction {
  type: number;
  createdBy: { id: string };
  description: string;
}

export interface CreateTicketPayload {
  type: number;
  origin: number;
  subject: string;
  status: string;
  ownerTeam: string;
  serviceFirstLevelId: number;
  serviceFull: string[];
  /** Omitir esta propriedade quando o fluxo confirmado exigir (ver src/config/tenant.ts). */
  category?: string;
  contactForm?: string;
  createdBy: { id: string };
  clients: TicketClientRef[];
  actions?: TicketAction[];
  customFieldValues?: TicketCustomFieldValue[];
}

export interface PatchTicketPayload {
  status?: string;
  justification?: string | null;
  ownerTeam?: string;
  category?: string;
  urgency?: string;
  actions?: TicketAction[];
  customFieldValues?: TicketCustomFieldValue[];
  [key: string]: unknown;
}

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  ownerTeam?: string;
  serviceFirstLevelId?: number;
  category?: string;
  [key: string]: unknown;
}

const MAX_SUBJECT_LENGTH = 128;

export function validateSubject(subject: string): string {
  if (!subject.trim()) throw new Error("Assunto do chamado não pode ser vazio.");
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`Assunto excede ${MAX_SUBJECT_LENGTH} caracteres (tem ${subject.length}).`);
  }
  return subject;
}

/** Escapa texto do usuário antes de embutir em HTML de uma ação/descrição. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function getTicket(id: number, select?: string[], expand?: string): Promise<TicketSummary> {
  return movideskHttp.get<TicketSummary>(`/tickets/${id}`, { select, expand });
}

export async function searchTickets(query: ODataQuery): Promise<TicketSummary[]> {
  if (!query.select?.length) {
    throw new Error("searchTickets exige $select — nunca liste tickets sem restringir os campos retornados.");
  }
  return movideskHttp.get<TicketSummary[]>("/tickets", query);
}

export async function createTicket(
  payload: CreateTicketPayload,
  returnAllProperties = false,
): Promise<{ id: number }> {
  validateSubject(payload.subject);
  const hasRequester = payload.clients.some((c) => c.isRequester);
  if (!hasRequester) {
    throw new Error("O solicitante deve aparecer em clients com isRequester: true.");
  }
  return movideskHttp.post<{ id: number }>(
    "/tickets",
    payload,
    returnAllProperties ? { select: undefined } : undefined,
  );
}

export async function patchTicket(id: number, payload: PatchTicketPayload): Promise<TicketSummary> {
  if ("status" in payload && !("justification" in payload)) {
    throw new Error(
      'Alterar "status" exige enviar "justification" junto (mesmo que null) — ' +
        'caso contrário a API responde "Update both Status and Reason".',
    );
  }
  return movideskHttp.patch<TicketSummary>(`/tickets/${id}`, payload);
}
