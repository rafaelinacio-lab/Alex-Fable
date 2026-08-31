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
 *  - O SEGUNDO gate, independente: `FOLLOWUP_AUTOCLOSE_ENABLED` — fechar um chamado
 *    sozinho é uma mutação MAIS sensível que só publicar uma mensagem (não dá pra
 *    desfazer com uma nova mensagem), então tem seu próprio opt-in global, separado do
 *    de cobrar. Cada perfil também tem seu próprio `autoCloseEnabled` — os dois
 *    (global E do perfil) precisam estar ligados para aquele perfil fechar chamados
 *    sozinho. Ligar a cobrança NÃO liga o fechamento automaticamente, e vice-versa.
 *  - O texto padrão da cobrança e do fechamento automático.
 */

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export function isFollowUpAutomationEnabled(): boolean {
  return parseBool(process.env.FOLLOWUP_AUTOMATION_ENABLED, false);
}

export function isFollowUpAutoCloseEnabled(): boolean {
  return parseBool(process.env.FOLLOWUP_AUTOCLOSE_ENABLED, false);
}

/** Mensagem padrão da cobrança automática. HTML já formatado (description de ação é HTML). */
export function buildFollowUpMessage(subject: string): string {
  return (
    "<p>Olá! Este chamado está aguardando um retorno seu há alguns dias. " +
    "Poderia nos atualizar sobre a situação, para que possamos continuar o atendimento?</p>" +
    `<p><em>Mensagem enviada automaticamente pelo Agente Movidesk — referente ao chamado "${subject}".</em></p>`
  );
}

/** Mensagem pública do fechamento automático (regra confirmada com o usuário, 2026-08-31:
 * chamado cobrado sem retorno de um dos clientes há mais de 24h úteis é encerrado sozinho). */
export function buildAutoCloseMessage(subject: string): string {
  return (
    "<p>Este chamado foi encerrado automaticamente por falta de retorno após a cobrança " +
    "anterior. Se ainda precisar de ajuda, é só reabrir ou abrir um novo chamado.</p>" +
    `<p><em>Mensagem enviada automaticamente pelo Agente Movidesk — referente ao chamado "${subject}".</em></p>`
  );
}
