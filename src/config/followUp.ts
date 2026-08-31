/**
 * Configuração da automação de cobrança de chamados aguardando retorno/validação do
 * cliente. Decisões de negócio confirmadas diretamente pelo usuário:
 *
 *  - Status monitorados: "Aguardando Retorno do Cliente" e "Aguardando Validação do
 *    Cliente" (confirmados no SLA de Atendimento — Movidesk deste tenant, seção 3).
 *  - Escopo: SOMENTE chamados da equipe "VIASOFT - Sistemas Internos" (mesmo ownerTeam
 *    do fluxo `sistemas_internos`, ver src/config/tenant.ts). Confirmado pelo usuário —
 *    não cobrar chamados de outras equipes.
 *  - Prazo de silêncio antes de cobrar: 3 dias ÚTEIS (não corridos), contados pelo
 *    calendário de expediente do SLA (seg-sex, 07:45-12:00 e 13:30-18:00 — ver
 *    src/movidesk/businessHours.ts). O usuário não especificou um número exato de dias
 *    quando perguntado — 3 dias úteis foi escolhido como padrão razoável e é
 *    configurável via FOLLOWUP_THRESHOLD_BUSINESS_DAYS.
 *  - A última ação do chamado tem que ser do OWNER (responsável) — se o último a
 *    interagir foi o cliente (ou qualquer outra pessoa), o chamado não é cobrado: o
 *    status pode não ter sido atualizado ainda, ou o cliente já respondeu e está
 *    aguardando o agente, não o contrário.
 *  - Remetente da cobrança: identidade dedicada "Alex Fable" (cod_ref confirmado pelo
 *    usuário: 007) — não o owner de cada chamado individualmente.
 *  - Envio automático, sem revisão humana antes de publicar a ação no chamado.
 *  - Roda em intervalo fixo (padrão 24h) enquanto o processo do agente estiver de pé.
 *
 * A automação só ativa de fato se `FOLLOWUP_AUTOMATION_ENABLED=true` no ambiente — por
 * ser uma mutação autônoma que fala com clientes reais sem revisão, puxar código novo
 * nunca deve ligar isso sozinho; é preciso opt-in explícito.
 */

export interface FollowUpConfig {
  enabled: boolean;
  /** Textos EXATOS de status monitorados — comparação sensível a maiúsculas/minúsculas no $filter. */
  waitingStatuses: string[];
  /** ownerTeam ao qual a automação se restringe — nunca cobra chamados de outra equipe. */
  ownerTeam: string;
  thresholdBusinessDays: number;
  checkIntervalHours: number;
  reminderSenderId: string;
  reminderSenderName: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export const FOLLOW_UP_CONFIG: FollowUpConfig = {
  enabled: parseBool(process.env.FOLLOWUP_AUTOMATION_ENABLED, false),
  waitingStatuses: ["Aguardando Retorno do Cliente", "Aguardando Validação do Cliente"],
  ownerTeam: process.env.FOLLOWUP_OWNER_TEAM ?? "VIASOFT - Sistemas Internos",
  thresholdBusinessDays: Number(process.env.FOLLOWUP_THRESHOLD_BUSINESS_DAYS ?? 3),
  checkIntervalHours: Number(process.env.FOLLOWUP_CHECK_INTERVAL_HOURS ?? 24),
  reminderSenderId: process.env.FOLLOWUP_SENDER_COD_REF ?? "007",
  reminderSenderName: "Alex Fable",
};

/** Mensagem padrão da cobrança automática. HTML já formatado (description de ação é HTML). */
export function buildFollowUpMessage(subject: string): string {
  return (
    "<p>Olá! Este chamado está aguardando um retorno seu há alguns dias. " +
    "Poderia nos atualizar sobre a situação, para que possamos continuar o atendimento?</p>" +
    `<p><em>Mensagem enviada automaticamente pelo Agente Movidesk — referente ao chamado "${subject}".</em></p>`
  );
}
