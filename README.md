# Agente Autônomo de Atendimento Movidesk (VIASOFT)

Implementação de referência do agente descrito em
[`prompts/movidesk-agent-system-prompt.md`](./prompts/movidesk-agent-system-prompt.md): um
agente que conversa com o usuário, resolve o solicitante, consulta o Movidesk e cria/altera
chamados com validação, idempotência e auditoria — nunca expondo o token da API ao modelo.

## Estrutura

```
prompts/movidesk-agent-system-prompt.md   # fonte única do comportamento do agente
src/config/tenant.ts                       # IDs de serviço/campo/regra confirmados (seção 6 do prompt)
src/movidesk/                              # cliente HTTP + recursos (tickets, persons, services)
src/local/                                 # diretórios locais: contatos (email->cod_ref), orgs, AD
src/store/                                 # auditoria, idempotência, rate limiter
src/agent/tools.ts                         # contrato de ferramentas (schemas zod + dispatch)
src/agent/orchestrator.ts                  # loop de function-calling com a API da OpenAI
src/agent/cli.ts                           # REPL de terminal para testar localmente (sobe o dashboard junto)
src/observability/eventBus.ts              # barramento de eventos (chamadas de ferramenta e de API), sanitizado
src/server/dashboard.ts + public/dashboard.html  # painel web ao vivo (WebSocket)
test/core.test.ts                          # smoke tests (escape, idempotência, rate limit, config)
```

## Como rodar localmente

```bash
npm install
cp .env.example .env   # preencha OPENAI_API_KEY, MOVIDESK_TOKEN, MOVIDESK_BASE_URL
npm run lint            # typecheck
npm test                # smoke tests (não fazem chamadas reais ao Movidesk)
npm run dev              # abre o REPL do agente no terminal E sobe o painel web
```

No Windows, copie o `.env.example` para `.env` na raiz do projeto (mesma pasta do
`package.json`) e edite os valores — não é preciso `set`/`$env:` no PowerShell nem
nenhuma configuração extra: `src/config/loadEnv.ts` lê o arquivo `.env` automaticamente
assim que o CLI inicia (é o primeiro import de `src/agent/cli.ts`). Se `npm run dev`
reclamar de credencial faltando, confira se o `.env` está na raiz do projeto e se as
linhas estão no formato `CHAVE=valor` sem espaços ao redor do `=`.

Ao rodar `npm run dev`, o terminal imprime a URL do painel (padrão
`http://localhost:4590`) — abra no navegador para acompanhar em tempo real cada
ferramenta que o agente chama e cada requisição feita à API do Movidesk (método,
caminho, status, duração), com input/output redigidos e truncados. Nenhum token ou
segredo trafega para essa página — ver `src/observability/eventBus.ts`.

Para testar sem depender de AD/Movidesk reais, copie os arquivos `*.example.json` em
`data/local/` para os nomes usados pelo `.env` (`movidesk_contatos.json`,
`organizacoes.json`, `ad_users.json`).

## Segurança e operação

- O `MOVIDESK_TOKEN` só existe dentro de `src/movidesk/client.ts`. O modelo nunca vê o
  token — ele chama ferramentas tipadas (`src/agent/tools.ts`), que por baixo chamam o
  cliente HTTP.
- Toda mutação (`movidesk_create_ticket`, `movidesk_patch_ticket`) grava um evento de
  auditoria em `data/audit/*.jsonl`, com hash do payload (não o payload cru) e sem
  segredos — `recordAuditEvent` lança erro se detectar uma chave sensível no evento.
- Criação de chamado exige `idempotency_key`; uma chave já resolvida com sucesso nunca
  gera um novo POST (`idempotencyReserve`).
- Todas as chamadas ao Movidesk passam por um rate limiter de janela deslizante
  (`RATE_LIMIT_PER_MINUTE`, padrão 10/min) com backoff e jitter em 429/5xx.
- Buscas em lista (`movidesk_search_*`) exigem `$select` — não é possível listar sem
  restringir campos.

## O que ainda precisa de trabalho antes de produção

Esta é uma implementação de referência, não um serviço pronto para produção. Faltam,
no mínimo:

1. **Persistência real** para auditoria/idempotência/rate-limit (hoje são arquivos JSON
   locais — funcionam para 1 processo, não escalam nem sobrevivem a múltiplas réplicas).
2. **Integração real de AD** (`src/local/directory.ts` tem só um adapter mock + um
   `LdapDirectoryAdapter` que lança `not implemented`).
3. **Integração real da tabela `movidesk_contatos`** (hoje é um JSON local; trocar por
   consulta ao banco/planilha sincronizada real).
4. **Canal de entrada** (Slack, Teams, portal web, etc.) — o `cli.ts` é só para teste.
5. **Testes de integração** contra um tenant de sandbox do Movidesk antes de qualquer
   fluxo de criação/cancelamento ir para produção.

## Revisão crítica do prompt original

Pontos que valem atenção antes de colocar em produção (nenhum invalida o design, mas
merecem decisão explícita):

- **Contradição de nomenclatura em "Contrato de ferramentas"**: o prompt lista
  `movidesk_search_tickets(filter, select, orderby?, top?, skip?)` sem marcar `top` como
  obrigatório, mas a seção 5 diz "para listas, sempre use `$select` e `$top`". Resolvido
  aqui dando um `default` a `top` no schema (20) em vez de deixar opcional — evite listas
  sem limite indo para o Movidesk.
- **`return_all_properties` em `movidesk_create_ticket` está subespecificado**: a doc
  pública do Movidesk usa esse parâmetro para controlar se o POST devolve o objeto
  completo ou só o `id`. O prompt não diz quando o agente deveria pedir `true` — deixei
  `false` como padrão (mais barato, e o Passo F já manda fazer um GET de verificação
  depois, então o retorno completo do POST é redundante).
- **Idempotência depende de `conversation_id`, que não está definido no prompt**: a seção
  7 assume que existe um "ID da conversa" estável, mas ele nunca é declarado como parte
  do contexto de entrada do agente. Implementei isso como responsabilidade do
  orquestrador (`AgentContext.conversationId`), gerado por sessão — mas se o canal real
  (ex: um mesmo ticket reaberto em threads diferentes de um chat) puder gerar duas
  `conversation_id` para a "mesma" intenção de criação, a idempotência não pega esse
  caso. Vale decidir explicitamente a granularidade antes de produção.
- **`justification: null` como "payload confirmado" é uma exceção frágil**: o prompt é
  correto em documentar isso como comportamento confirmado deste tenant, mas é o tipo de
  coisa que quebra silenciosamente se alguém configurar uma justificativa obrigatória
  para o status "Cancelado" no futuro. Sugiro tratar esse 400 (`Update both Status and
  Reason` continuando a falhar mesmo com `justification: null`) como sinal para consultar
  `get_flow_config`/justificativas antes de tentar de novo, em vez de assumir que
  `null` sempre funciona — o código atual (`patchTicket`) só valida que os dois campos
  foram enviados juntos, não que `null` é sempre aceito.
- **Seção 6 mistura "campo adicional de classificação" (23946/11397) com fluxos que usam
  a propriedade nativa `category`** (Oracle Cloud e Sistemas Internos usam `category:
  "Suporte Técnico"` nativa, enquanto GCC usa o campo adicional 23946/11397 com o mesmo
  valor de opção). O prompt já alerta para "não confundir", mas o risco real é o modelo
  copiar o padrão de um fluxo para outro por similaridade textual. Modelei isso em
  `tenant.ts` como `nativeCategory` (string | "omit" | "dynamic") separado de
  `customFields.classificacao`, para que fiquem estruturalmente diferentes mesmo tendo o
  mesmo texto "Suporte Técnico".
- **GCC e Sistemas Internos têm serviço "dinâmico"** sem uma ferramenta explícita para
  resolvê-lo — o prompt diz "vem do catálogo local sincronizado" mas não há uma função
  `list_services_for_flow` no contrato de ferramentas. Hoje isso cai em
  `movidesk_search_services`, o que obriga o agente a montar o `$filter` certo sem
  orientação estruturada. Se esse fluxo for usado com frequência, vale adicionar uma
  ferramenta dedicada (ex: `list_gcc_services(query)`) em vez de depender de OData livre.
- **Nenhuma menção a rate limit por usuário/conversa, só global por token** — em um
  cenário de múltiplos usuários simultâneos, um usuário fazendo buscas em excesso pode
  consumir a cota de 10 req/min de todo mundo. O `RateLimiter` atual é global (por
  processo), como o prompt descreve, mas é uma limitação a considerar se o volume
  crescer — ver seção "O que ainda precisa de trabalho".
- **Auditoria não define retenção nem quem pode ler os logs.** A seção 10 lista o que
  logar e o que nunca logar, mas não trata controle de acesso ao próprio log de
  auditoria (que ainda assim contém e-mail e IDs de chamado/pessoa). Definir isso é
  necessário para conformidade de dados pessoais.

Nenhum desses pontos é um erro de execução do prompt — são decisões que o prompt deixa
implícitas e que a implementação teve que fixar de um jeito. Documentei as escolhas feitas
em comentários no código (`tenant.ts`, `tools.ts`, `tickets.ts`) para que fiquem
rastreáveis se precisarem ser revistas.
