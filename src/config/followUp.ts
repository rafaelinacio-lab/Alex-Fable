/**
 * Interruptor GERAL e mensagem da automação de cobrança de retorno do cliente.
 *
 * A configuração por equipe (status monitorados, prazo, janela de expediente/SLA,
 * remetente) NÃO fica mais aqui — vive em perfis configuráveis pelo painel, ver
 * src/config/followUpProfiles.ts. Isto aqui é só o que continua sendo global:
 *
 *  - O gate de segurança: a automação só roda de fato se `FOLLOWUP_AUTOMATION_ENABLED=
 *    true` no ambiente — por ser uma mutação autônoma que fala com clientes reais sem
 *    revisão, puxar código novo (ou criar um perfil novo pelo painel) nunca deve ligar
 *    isso sozinho; é preciso opt-in explícito no `.env`. Cada perfil também tem seu
 *    próprio `enabled` — os dois precisam estar ligados para aquele perfil rodar.
 *  - O texto padrão da cobrança.
 */

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export function isFollowUpAutomationEnabled(): boolean {
  return parseBool(process.env.FOLLOWUP_AUTOMATION_ENABLED, false);
}

/** Mensagem padrão da cobrança automática. HTML já formatado (description de ação é HTML). */
export function buildFollowUpMessage(subject: string): string {
  return (
    "<p>Olá! Este chamado está aguardando um retorno seu há alguns dias. " +
    "Poderia nos atualizar sobre a situação, para que possamos continuar o atendimento?</p>" +
    `<p><em>Mensagem enviada automaticamente pelo Agente Movidesk — referente ao chamado "${subject}".</em></p>`
  );
}
