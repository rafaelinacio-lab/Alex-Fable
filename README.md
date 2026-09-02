# Agente Autônomo de Atendimento Movidesk (VIASOFT)

Implementação de referência do agente descrito em
[`prompts/movidesk-agent-system-prompt.md`](./prompts/movidesk-agent-system-prompt.md): um
agente que conversa com o usuário, resolve o solicitante, consulta o Movidesk e cria/altera
chamados com validação, idempotência e auditoria — nunca expondo o token da API ao modelo.

> **Documentação completa** (o que o agente faz, arquitetura, capacidades, fluxos
> suportados, histórico de decisões): [`docs/DOCUMENTACAO.md`](./docs/DOCUMENTACAO.md).
> Este README foca em como instalar e rodar.

## Estrutura

```
prompts/movidesk-agent-system-prompt.md   # fonte única do comportamento do agente
docs/movidesk-api-tickets.md               # documentação de referência da API de Tickets (endpoints, enums, exemplos)
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
linhas estão no formato `CHAVE=valor` sem espaços ao redor do `=`. `loadEnv.ts` já lida
com `.env` salvo como "UTF-8 com BOM" (comum ao editar no Notepad ou redirecionar saída
no PowerShell).

Se `npm run dev` continuar reclamando de credencial faltando, rode `npm run check-env`
**antes** de tentar mais nada — ele mostra, sem nunca imprimir a credencial em si, se o
`.env` foi encontrado, em qual caminho, se tem BOM, e se cada variável chegou vazia,
ausente ou preenchida (com tamanho e prefixo/sufixo mascarados). Isso substitui
ficar tentando adivinhar a causa: geralmente ou o `.env` está em outra pasta (rodando
`npm run dev` de um diretório diferente da raiz do projeto), ou a linha ficou sem valor
depois do `=`.

Ao rodar `npm run dev`, o terminal imprime a URL do painel (padrão
`http://localhost:4590`) — abra no navegador. O painel tem duas abas:

- **Atividade** — acompanha em tempo real cada ferramenta que o agente chama e cada
  requisição feita à API do Movidesk (método, caminho, status, duração), com
  input/output redigidos e truncados. Nenhum token ou segredo trafega para essa página —
  ver `src/observability/eventBus.ts`.
- **Conversa** — chat com o agente direto pelo navegador (WebSocket `/chat`,
  `src/server/dashboard.ts`). Terminal e navegador falam com a **mesma sessão** do
  agente — a mesma conversa, o mesmo histórico, o mesmo contador de rate limit — então
  dá pra alternar entre os dois sem perder contexto. Se você abrir várias abas do
  painel, todas veem as mesmas mensagens em tempo real. Assim que um Excel/PDF é gerado,
  aparece um cartão de download direto na conversa (📊/📄 + botão "Baixar") — o arquivo é
  servido pelo próprio painel em `/exports/<nome-do-arquivo>`, então funciona mesmo que
  você não tenha acesso direto ao disco onde o agente está rodando.

Para testar sem depender de AD/Movidesk reais, copie os arquivos `*.example.json` em
`data/local/` para os nomes usados pelo `.env` (`movidesk_contatos.json`,
`organizacoes.json`, `ad_users.json`). O catálogo de serviços (`data/local/servicos.json`)
já vem com dados reais — não é um `.example.json` (ver seção abaixo).

## Catálogo de serviços (resolve ambiguidade de nome)

`data/local/servicos.json` é o catálogo de serviços do Movidesk (exportado de
Configurações > Serviços), usado pela ferramenta `list_known_services`. Existe porque
buscar serviço por nome direto na API é ambíguo neste tenant: a mesma folha pode existir
sob várias hierarquias com IDs diferentes (ex: "Construshow" aparece 8 vezes — nível
topo, e sob GCC, HOK Cursos, Oracle Cloud, Migração, Implantação, Paralisações,
Personalizações). O agente usa esse catálogo para resolver `nome`/`servico` antes de
montar o filtro `serviceFull` (ver seção "Serviços, categoria e equipe" do prompt de
sistema). Se a exportação do Movidesk mudar, gere um novo `servicos.json` com as colunas
`id, servico, nome, descricao, disponivelParaTickets, ativo` e substitua o arquivo.

## Contagens exatas, "em aberto" e exportação para Excel

Três capacidades que exigem ferramentas específicas — não confie no modelo "montando"
isso sozinho a partir de buscas soltas:

- **"Chamados em aberto"** → o agente usa `only_open: true` em
  `movidesk_search_tickets_exhaustive`/`export_tickets_search_to_excel`, que filtra pelo
  campo `baseStatus` (enum confirmado: New/InAttendance/Stopped = aberto,
  Resolved/Canceled/Closed = não) **depois de buscar, no próprio código** — não tenta
  montar isso como filtro OData (`ne`/`or`/`not` não são operadores confirmados nesta
  API). Corrige um bug real: um pedido de "chamados em aberto" retornou chamados com
  status "Resolvido" porque o filtro tentado não excluía status corretamente.

- **"Quantos chamados", "todos os chamados"** → o agente usa
  `movidesk_search_tickets_exhaustive`, que pagina de verdade até o fim (até 150 páginas /
  ~15.000 registros de limite de segurança) e devolve `exact_total`/`hitCap`. A API do
  Movidesk não suporta `$count`, então qualquer número que não vier dessa ferramenta é uma
  estimativa — o prompt instrui o agente a nunca apresentar estimativa como total exato.
  Isso é uma única chamada de ferramenta que roda até o fim sozinha (pode levar minutos
  em volumes grandes, por causa do rate limit de 10 req/min) — o prompt também instrui o
  agente a não interromper essa busca pedindo confirmação a cada lote de 100, nem cair de
  volta em paginação manual conversando sobre cada página.
- **"Me dá um Excel/planilha/CSV"** → o agente usa `export_tickets_search_to_excel`, que
  faz a busca exaustiva E grava o `.xlsx` de verdade em `EXPORTS_DIR` (padrão `./exports`,
  veja `.env.example`) **inteiramente no servidor, numa única chamada de ferramenta** —
  os registros nunca precisam passar pelo modelo como texto. Isso corrige um bug real: a
  versão anterior (`export_tickets_to_excel` com `rows` vindas do modelo) exigia que o
  modelo retransmitisse cada linha como argumento, o que truncava silenciosamente em
  volumes grandes (um pedido de 643 chamados virava um arquivo com só 20, depois 500).
  `export_tickets_to_excel` continua existindo só para linhas pequenas (até 200) que o
  modelo já tem prontas na conversa — nunca para exportar o resultado de uma busca.
- **"Me dá um PDF/relatório"** → mesmo padrão em `export_tickets_search_to_pdf`
  (`src/local/pdfExport.ts`, via `pdfkit`): tabela paginada automaticamente, gravada
  inteiramente no servidor. Limite bem menor que o Excel (5.000 linhas) — PDF é para
  relatório legível, não para descarregar bases inteiras; acima disso o agente é
  instruído a usar Excel e explicar o motivo.

## Trocando o modelo da OpenAI

Basta mudar `OPENAI_MODEL` no `.env`. Se usar um modelo de raciocínio (série gpt-5.x —
gpt-5.6-luna, gpt-5.4, etc.) e receber o erro `Function tools with reasoning_effort are
not supported for <modelo> ... set reasoning_effort to 'none'`, defina também
`OPENAI_REASONING_EFFORT=none` no `.env` (veja `.env.example`). Deixe essa variável em
branco para modelos que não são de raciocínio (ex: gpt-4.1) — passá-la sem necessidade
pode dar erro em modelos que não aceitam o parâmetro.

## Cobrança automática de retorno do cliente (proativa, configurável pelo painel)

O agente pode rodar sozinho, em segundo plano, e cobrar chamados que estão "parados"
esperando o cliente — em uma ou VÁRIAS equipes, cada uma com sua própria regra de SLA
(status monitorados, expediente/janela de horário útil, prazo, intervalo, remetente).
Implementação: `src/agent/followUp.ts` (regra, roda por perfil),
`src/config/followUpProfiles.ts` (perfis — CRUD, um por equipe),
`src/agent/followUpScheduler.ts` (agendamento em `src/agent/cli.ts`),
`src/config/followUp.ts` (interruptor geral).

**Configuração pelo painel** (aba "Automação", `http://localhost:$DASHBOARD_PORT`): cada
"perfil" tem um ESCOPO — **equipe inteira** (`ownerTeam`, tem que bater exatamente com o
Movidesk) OU **um owner/responsável específico** (cod_ref daquela pessoa) — e sua própria
regra: status monitorados, prazo em dias úteis, sua PRÓPRIA janela de expediente
(manhã/tarde), intervalo de verificação e a identidade que assina a cobrança. O formulário
do painel tem um seletor "Equipe inteira" / "Um owner específico" que troca os campos
pedidos. Dá pra criar, editar, habilitar/desabilitar e excluir perfis sem mexer em código
nem reiniciar o processo — é exatamente para isso que existe: hoje só "Sistemas Internos"
está configurada, mas amanhã pode existir uma equipe (ou uma pessoa específica) com SLA
diferente rodando ao lado, sem precisar alterar nada além do painel. Na primeira execução
um perfil é criado sozinho para a equipe "VIASOFT - Sistemas Internos" (compatibilidade
com a configuração anterior, que era fixa por variável de ambiente).

**Regra**, aplicada dentro de CADA perfil: um chamado é cobrado quando, ao mesmo tempo:

0. o chamado está no escopo daquele perfil — nenhum chamado fora dele é tocado. Para
   escopo por equipe, o filtro é aplicado tanto na busca (`$filter` OData) quanto
   localmente no código (defesa em profundidade: mesmo que o filtro do servidor
   falhasse silenciosamente, nenhum chamado de outra equipe seria cobrado). Para escopo
   por owner, não existe um filtro OData confirmado por propriedade de navegação
   singular (diferente do `clients/any(...)` que é array e está documentado) — então o
   filtro por `owner.id` acontece só localmente, depois de buscar por status;
1. o `status` é um dos monitorados por aquele perfil, E — se o perfil configurar
   "Justificativas monitoradas" — o campo `justification` do chamado também bate.
   **Importante**: em vários tenants (confirmado em produção real) o `status` sozinho é
   genérico (ex: "Aguardando", `baseStatus` "Stopped") e é o `justification` que diz a
   razão específica (ex: "Validação Cliente", "Retorno Cliente"). Antes de configurar um
   perfil, busque um chamado real nessa situação e confira os dois campos — configurar só
   pelo texto do `status` supondo que ele já é descritivo (ex: "Aguardando Retorno do
   Cliente" como se fosse o texto literal do status) é a causa mais comum de a automação
   rodar e não encontrar nenhum chamado;
2. a ÚLTIMA ação do chamado foi feita pelo `owner` (responsável) — se o cliente (ou
   qualquer outra pessoa) foi quem agiu por último, o chamado não é cobrado (pode ser
   que o cliente já tenha respondido e o status só não foi atualizado ainda);
3. o tempo decorrido desde a referência — a mais recente entre a data dessa última ação
   e a data em que o chamado entrou no status atual (`statusHistories`) — já passou do
   prazo configurado NAQUELE perfil, contado em **horas úteis pela janela de expediente
   DAQUELE perfil** (não uma janela global fixa — `src/movidesk/businessHours.ts`), não
   em dias corridos. Equipes com SLAs diferentes usam janelas diferentes.

Cada chamado que bate todas as condições recebe uma ação pública automática, publicada
pela identidade configurada no perfil (padrão "Alex Fable", cod_ref 007 — nunca o owner
individual). Como o remetente da cobrança não é o owner, na rodada seguinte a regra 2
já não bate mais para aquele chamado (a última ação passa a ser da própria automação)
— isso evita cobrar o mesmo silêncio duas vezes, sem precisar de nenhum controle extra.

### Onde acompanhar no painel

- **Aba "Automação"**: lista todos os perfis, com o estado do interruptor geral no
  topo, um card por perfil (escopo — equipe ou owner —, status monitorados, prazo,
  expediente, intervalo, remetente, última execução) e botões para Editar, Rodar agora e
  Excluir cada um; o botão "+ Novo perfil" cria outro escopo do zero.
- **Aba "Conversa"**: ao fim de cada rodada, aparece um aviso em itálico marcado como
  "automação" com o resumo daquele perfil — quantos chamados foram verificados, quais
  foram cobrados (`#id`), e falhas, se houver. É publicado direto pelo processo
  (`dashboard.announceSystemMessage`), sem passar pelo modelo.
- **Aba "Atividade"**: cada rodada também aparece como uma chamada de ferramenta
  `followUp.runFollowUpCheck[<nome do perfil>]` (status ok/error, com
  `checkedCount`/`chargedIds`/`errorIds` no output) — é o mesmo canal de eventos usado
  para toda chamada real à API do Movidesk, então dá pra ver ali as buscas
  (`GET /tickets`) e o `PATCH /tickets` de cada cobrança.
- Também dá pra pedir "verifica agora" na conversa — o agente chama
  `check_pending_customer_tickets()`, que roda TODOS os perfis habilitados na hora, fora
  do ciclo automático.

**Desligada por padrão** (`FOLLOWUP_AUTOMATION_ENABLED=false`, no `.env`): é uma
automação que publica mensagens para clientes reais sem revisão humana — puxar código
novo (ou criar um perfil novo pelo painel) nunca deve ligar isso sozinho. Esse
interruptor é geral: mesmo com perfis habilitados no painel, nada roda enquanto ele não
for `true`. Depois de ativado, cada perfil roda sozinho no seu próprio intervalo
(verificado a cada `FOLLOWUP_TICK_MINUTES`, padrão 15min — não precisa mexer nisso).

O prazo de silêncio (`thresholdBusinessHours`) é contado em **HORAS úteis** (padrão 24h),
não dias — confirmado com o usuário para poder expressar um valor exato em vez de uma
aproximação em dias úteis cheios.

## Aba "Cobranças" e fechamento automático (opcional)

Cobrar e fechar são decididos na **MESMA passada** por chamado (`evaluateTicket` em
`src/agent/followUp.ts`) — não é um sistema separado que roda depois: cada chamado
examinado é avaliado uma vez e o resultado é cobrar, fechar, ou não fazer nada.

Opcionalmente, um chamado cujo **owner** está em silêncio há tempo demais pode ser
**fechado sozinho** (`status: "Resolvido"`), com uma ação pública explicando o motivo,
publicada pela mesma identidade que cobra. Regra (confirmada com o usuário, 2026-09-01):

1. escopo, status/justification e "última ação real foi do owner" — mesmas três
   primeiras condições da cobrança (ver acima; "real" já exclui as próprias ações da
   automação, então uma cobrança anterior não é tratada como resposta de ninguém);
2. o tempo decorrido desde essa última ação real do owner (não desde uma cobrança
   anterior — o fechamento **não depende** de o chamado já ter sido cobrado) já passou
   de `autoCloseThresholdBusinessDays` (regra de SLA do perfil — padrão 3 dias úteis).

Fechar tem prioridade sobre cobrar: se o prazo de fechamento (mais longo) já venceu, o
chamado é fechado direto, sem mandar cobrança antes.

É uma automação **mais sensível** que só publicar uma mensagem (fechar não dá pra
desfazer com uma nova mensagem), por isso tem gate **duplo e independente** do de cobrar:

- `FOLLOWUP_AUTOCLOSE_ENABLED=false` no `.env` (interruptor geral, separado de
  `FOLLOWUP_AUTOMATION_ENABLED` — ligar a cobrança nunca liga o fechamento);
- `autoCloseEnabled` por perfil (painel, switch dedicado — pede confirmação explícita ao
  ligar, porque é uma mutação autônoma sem revisão humana).

Os dois precisam estar ligados para aquele perfil fechar chamados sozinho.

A aba **"Cobranças"** do painel tem duas partes: **"Última verificação"** (por perfil) —
todo chamado examinado na rodada mais recente, cobrado/fechado/pulado com o motivo,
horas úteis decorridas, e quanto falta para cobrar/fechar cada um (calculado do estado
real do chamado, não de um valor congelado); e **"Histórico de cobranças enviadas"** —
só quando cada chamado recebeu a mensagem de cobrança (`src/store/followUpCharges.ts`).

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

## Correção importante: endpoints da API (v0.1 tinha um bug)

Versões anteriores deste projeto chamavam `GET/PATCH /tickets/{id}` (ID no *path*), o
que está **errado**. Confirmado por `docs/movidesk-api-tickets.md`: a API do Movidesk
não usa path REST para identificar um registro — o ID vai sempre na query string
(`GET /tickets?id=123`, `PATCH /tickets?id=123`). Isso já foi corrigido em
`src/movidesk/tickets.ts`, `persons.ts` e `services.ts`. Se você tiver algum fork ou
cópia anterior deste código, atualize antes de usar em produção.

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
