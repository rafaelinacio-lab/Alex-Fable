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

/**
 * Mensagem padrão da cobrança automática. HTML já formatado (description de ação é HTML).
 * Redação (2026-09-01) baseada num texto que o usuário mandou como referência de tom —
 * mais pessoal e menos "robótica" que a versão anterior ("está aguardando um retorno
 * seu há alguns dias"). O aviso "enviado automaticamente" foi removido do texto a
 * pedido do usuário (2026-09-01) — a transparência de que é automação fica só na
 * auditoria/painel internos, não mais visível pro cliente na própria mensagem.
 */
export function buildFollowUpMessage(): string {
  return (
    "<p>Olá! Espero que esteja tudo bem por aí.</p>" +
    "<p>Passando para saber se você conseguiu verificar as informações que enviamos anteriormente. " +
    "Seu retorno é importante para conseguirmos dar continuidade ao atendimento e avançar com a melhor solução possível.</p>" +
    "<p>Caso ainda precise de algum apoio ou tenha ficado alguma dúvida, estamos à disposição para ajudar. " +
    "Ficamos no aguardo do seu retorno!</p>"
  );
}

/** Mensagem pública do fechamento automático (regra confirmada com o usuário, 2026-08-31:
 * chamado com owner em silêncio há mais que o prazo de SLA é encerrado sozinho). Mesmo
 * tom da cobrança acima, sem o aviso de automação (ver nota em buildFollowUpMessage). */
export function buildAutoCloseMessage(): string {
  return (
    "<p>Olá! Como não tivemos retorno sobre este chamado mesmo após o nosso contato anterior, " +
    "vamos encerrá-lo por aqui.</p>" +
    "<p>Se ainda precisar de ajuda ou se surgir alguma dúvida, é só reabrir este chamado ou abrir um novo — " +
    "ficaremos felizes em continuar te ajudando!</p>"
  );
}
