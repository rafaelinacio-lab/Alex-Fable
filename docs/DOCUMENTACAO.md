# Documentação — Agente Autônomo de Atendimento Movidesk (VIASOFT)

> Este documento descreve **o que o agente é, o que ele faz e como está construído**.
> Para instruções de instalação/execução, veja [`README.md`](../README.md). Para a
> especificação completa de comportamento (regras, limites, fluxos), a fonte de verdade é
> [`prompts/movidesk-agent-system-prompt.md`](../prompts/movidesk-agent-system-prompt.md)
> — este documento resume e explica, mas não substitui aquele.

## 1. O que é

Um agente conversacional que atende chamados no Movidesk da VIASOFT: entende o pedido do
usuário, consulta pessoas/organizações/serviços/chamados na API real do Movidesk, coleta
só as informações necessárias, e cria/consulta/altera/cancela chamados — com validação,
idempotência e auditoria, sem nunca expor o token da API ao modelo de linguagem.

Não é um gerador de JSON nem um chatbot de FAQ: ele executa operações reais contra um
Movidesk de produção através de ferramentas tipadas e validadas no servidor.

## 2. Como usar

Duas interfaces, uma única conversa:

- **Terminal** (`npm run dev`): REPL simples, digite e receba resposta.
- **Painel web** (`http://localhost:4590`, sobe junto com o terminal): duas abas —
  - **Atividade**: acompanha em tempo real cada ferramenta chamada e cada requisição à
    API do Movidesk (método, caminho, status, duração), com dados sensíveis redigidos.
  - **Conversa**: chat pelo navegador. Terminal e navegador conversam com a **mesma
    sessão** — mesmo histórico, mesmo estado, mesmo limite de requisições.

Instalação e configuração (`.env`, dependências, diagnóstico de credenciais) estão no
[`README.md`](../README.md).

## 3. Arquitetura

```
                      ┌────────────────────────┐
   Terminal (CLI) ───▶│                        │
                      │  MovideskAgentSession   │──▶ OpenAI (function calling)
   Painel Web ───────▶│  (orchestrator.ts)      │
   (aba Conversa)     │                        │
                      └───────────┬────────────┘
                                  │ dispatchTool()
                                  ▼
                      ┌────────────────────────┐
                      │   Contrato de ferramentas│  (tools.ts — schemas zod,
                      │                          │   único ponto de contato
                      └───────────┬──────────────┘   modelo ↔ mundo real)
                                  │
        ┌─────────────┬──────────┼───────────┬──────────────┐
        ▼             ▼          ▼           ▼              ▼
   Movidesk API   Diretórios   Auditoria  Idempotência   Exportação
  (client.ts +    locais       (audit.ts) (idempotency   Excel
   tickets/       (contacts,                .ts)          (export.ts)
   persons/       directory)
   services.ts)
        │
        ▼
   agentEventBus ──▶ Painel Web (aba Atividade, via WebSocket /ws)
```

Princípio central: **o modelo (LLM) nunca vê o token da API nem monta requisições HTTP
diretamente.** Ele só invoca ferramentas nomeadas (`movidesk_get_ticket`,
`movidesk_create_ticket`, etc.), cada uma com schema validado em `src/agent/tools.ts`.
Só o módulo `src/movidesk/client.ts` lê `MOVIDESK_TOKEN` do ambiente.

### Mapa de arquivos

| Caminho | O que é |
|---|---|
| `prompts/movidesk-agent-system-prompt.md` | Especificação de comportamento — fonte única, carregada em runtime |
| `docs/movidesk-api-tickets.md` | Referência da API de Tickets do Movidesk (endpoints, campos, enums confirmados) |
| `src/config/tenant.ts` | IDs de serviço/campo/regra confirmados por fluxo de negócio deste tenant |
| `src/config/loadEnv.ts` | Carrega `.env` (com tratamento de BOM do Windows) |
| `src/config/checkEnv.ts` | Diagnóstico de configuração (`npm run check-env`) |
| `src/movidesk/client.ts` | Cliente HTTP — único lugar que lê o token; rate limit, retry/backoff |
| `src/movidesk/{tickets,persons,services}.ts` | Operações tipadas por recurso |
| `src/local/{contacts,directory,export,pdfExport,serviceCatalog}.ts` | Diretório local de contatos/organizações, busca AD, exportação Excel/PDF, catálogo de serviços |
| `src/store/{audit,idempotency,rateLimiter}.ts` | Auditoria, idempotência de criação, limitador de requisições |
| `src/agent/tools.ts` | Contrato de ferramentas — schemas zod + dispatch, único ponto de contato com o modelo |
| `src/agent/orchestrator.ts` | Loop de function-calling com a API da OpenAI |
| `src/agent/cli.ts` | Ponto de entrada (REPL de terminal + sobe o painel web) |
| `src/observability/eventBus.ts` | Barramento de eventos sanitizado, alimenta o painel web |
| `src/server/dashboard.ts` + `public/dashboard.html` | Servidor e página do painel web |
| `test/core.test.ts` | Testes de regressão (escape, idempotência, rate limit, export, env) |

## 4. Capacidades

- Entender a intenção do usuário (dúvida, consulta, criação, alteração, cancelamento).
- Resolver o solicitante automaticamente a partir do usuário autenticado (e-mail → cod_ref).
- Buscar pessoas, organizações, serviços e chamados — na lista local sincronizada e,
  como fallback, direto na API real do Movidesk (`movidesk_search_organizations`, etc.).
- Criar chamados completos e corretamente classificados, seguindo fluxos de negócio
  pré-validados deste tenant (ver seção 6).
- Consultar chamados por ID ou protocolo, incluindo o HTML de uma ação específica.
- Alterar chamados (status, responsável, campos adicionais) preservando coleções que não
  devem ser perdidas (o PATCH do Movidesk sobrescreve listas inteiras).
- Cancelar/reabrir chamados com verificação pós-operação.
- Paginar exaustivamente uma busca grande (até ~15.000 registros) numa única operação,
  sem precisar de confirmação a cada lote — e ser honesto quando não é possível saber o
  total exato (a API do Movidesk não suporta `$count`).
- Exportar resultados para um arquivo `.xlsx` real, gravado em disco.

## 5. Contrato de ferramentas (resumo)

Especificação completa na seção 4 do prompt de sistema. Categorias:

- **Contexto/local**: `get_authenticated_user`, `find_movidesk_contact_by_email`,
  `search_ad_users`, `list_customer_organizations`, `list_known_services`, `get_flow_config`.
- **Leitura Movidesk**: `movidesk_get_ticket[_by_protocol]`, `movidesk_get_ticket_action_html`,
  `movidesk_search_tickets[_past]`, `movidesk_search_tickets_exhaustive`,
  `movidesk_search_organizations`, `movidesk_get_person`, `movidesk_search_persons`,
  `movidesk_get_service`, `movidesk_search_services`.
- **Mutação Movidesk**: `movidesk_create_ticket` (exige `idempotency_key`),
  `movidesk_patch_ticket`.
- **Saída**: `export_tickets_search_to_excel`/`export_tickets_search_to_pdf` (busca +
  exportação em uma chamada, server-side — usar sempre que envolver o resultado de uma
  busca), `export_tickets_to_excel`/`export_tickets_to_pdf` (só para linhas pequenas que
  o modelo já tem prontas, até 200). PDF tem limite bem menor (5.000 linhas) que Excel.

Toda ferramenta tem schema validado (`zod`) em `src/agent/tools.ts` — o modelo nunca
manda JSON solto direto para a API; o schema rejeita antes.

## 6. Fluxos de negócio suportados

Configuração central em [`src/config/tenant.ts`](../src/config/tenant.ts), carregada via
`get_flow_config(flow_name)`:

| Fluxo | Serviço | Equipe | Observação principal |
|---|---|---|---|
| `comite_ia` | Comitê de IA | VIASOFT - Comitê de IA | Omitir `category` nativa (confirmado: causa erro se enviada) |
| `voors_escola_negocios` | HOK Cursos | VIASOFT - HOK | Cliente via lista local; colaborador via busca AD |
| `oracle_cloud` | Oracle Cloud | VIASOFT - Suporte Oracle Cloud | Reutiliza busca de colaboradores/organizações |
| `gcc` | dinâmico (catálogo local) | GCC - Gestão de Combate ao Churn | Serviço/organização nunca fixos, sempre do catálogo sincronizado |
| `sistemas_internos` | Sistemas Internos | VIASOFT - Sistemas Internos | "Cadastro de Usuários" implica urgência baixa |

Para consultas livres (ex: "chamados da organização X") que não pertencem a um fluxo
fixo, o agente usa `movidesk_search_organizations` + `movidesk_search_tickets_exhaustive`
diretamente contra a API, sem depender de catálogo.

## 7. Segurança e auditoria

- O token do Movidesk só existe em `src/movidesk/client.ts`; nunca chega ao modelo, a
  logs, ou ao painel web.
- Toda mutação (`movidesk_create_ticket`, `movidesk_patch_ticket`) é registrada em
  `data/audit/*.jsonl` com hash do payload (não o payload cru) — `recordAuditEvent`
  recusa gravar se detectar uma chave sensível.
- Criação de chamado exige `idempotency_key`; uma chave já resolvida com sucesso nunca
  dispara um novo POST (protege contra duplicação em timeout/retry).
- Rate limiter de janela deslizante (`RATE_LIMIT_PER_MINUTE`, padrão 10/min), com
  backoff e jitter em 429/5xx — alinhado ao comportamento documentado da API (bloqueio
  escalonado de 60s/120s/300s após erros seguidos).
- Painel web (eventos e chat) roda em `localhost`, sem autenticação própria — assume-se
  ambiente de desenvolvimento local de confiança (ver seção 9, limitações).

## 8. Decisões e correções (histórico condensado)

Registro do que já foi corrigido, para não reintroduzir os mesmos problemas:

1. **Endpoint por path vs. query string**: a API do Movidesk identifica registros via
   `?id=`, nunca `/tickets/{id}`. Corrigido em `tickets.ts`/`persons.ts`/`services.ts`.
2. **Organização não encontrada**: o agente só buscava numa lista local que não vem
   populada por padrão. Corrigido com fallback para a API real
   (`movidesk_search_organizations`, filtrando `personType eq 2`).
3. **Contagens inventadas / rota `/tickets/past` inexistente**: o agente chegou a
   afirmar ter consultado uma rota sem tooling real, e a estimar totais como se fossem
   exatos. Corrigido com `searchTicketsPast` real e `movidesk_search_tickets_exhaustive`
   com sinalização explícita de `exact_total`.
4. **Sem entrega de arquivo real**: pedidos de "Excel/CSV" resultavam em texto colado no
   chat. Corrigido com `export_tickets_to_excel`, que grava `.xlsx` em disco.
4b. **Exportação truncando silenciosamente em volumes grandes** (643 chamados viravam
    arquivos de 20, depois 500): `export_tickets_to_excel` exigia que o modelo
    retransmitisse cada linha como argumento da chamada de ferramenta — estourava o
    limite de tokens de saída do modelo antes de completar. Corrigido com
    `export_tickets_search_to_excel`, que faz a busca exaustiva E grava o arquivo
    inteiramente no servidor, sem os registros passarem pelo contexto do modelo.
5. **Filtro OData inventado** (`creation`/`year(...)`): corrigido apontando o campo
   confirmado (`createdDate`, comparação `ge`/`le`) e reforçando que erros 400 devem ser
   diagnosticados com o `errorMessage` literal, não parafraseados.
6. **`.env` não carregado no Windows** (BOM UTF-8): `loadEnv.ts` agora remove o BOM antes
   de interpretar o arquivo; `npm run check-env` diagnostica sem expor segredos.
7. **Paginação exaustiva abandonada em favor de loop manual conversacional**: ao bater no
   limite de páginas, o agente passou a simular paginação manual pedindo confirmação a
   cada lote. Corrigido subindo o limite (até 150 páginas) e reforçando que buscas
   paginadas são só GETs — executam até o fim numa única chamada de ferramenta.
8. **Buscar chamados por serviço deve filtrar por `serviceFull`, não `serviceFirstLevelId`**
   (confirmado pelo usuário em uso real): filtro validado é
   `serviceFull/any(s: s eq 'Nome do Serviço')`. Documentado na seção "Serviços, categoria
   e equipe" do prompt de sistema — importante porque pode haver múltiplos serviços
   cadastrados com o mesmo nome e IDs diferentes.
9. **Catálogo de serviços** (`data/local/servicos.json`, ferramenta `list_known_services`):
   exportação oficial do Movidesk (78 serviços) usada para resolver `nome`/`servico` antes
   de montar o filtro `serviceFull` — evita a ambiguidade descoberta no item 8 (ex:
   "Construshow" existe 8 vezes sob hierarquias diferentes, todas com o mesmo `nome` mas
   `servico`/id distintos).
10. **Retry em GET provocava o próprio bloqueio 429 que deveria evitar**: o cliente tentava
    até 3 vezes em 5xx, e a API conta requisições com erro para o bloqueio escalonado
    (3 erros seguidos -> 60s, +3 -> 120s, +3 -> 300s) — uma única chamada de ferramenta
    contra um endpoint com problema (ex: `/tickets/past`) já bastava para travar o agente
    sozinha. Corrigido: máximo 2 tentativas em 5xx (não 3), 429 nunca faz retry automático
    (evita dormir minutos dentro de uma chamada de ferramenta e mandar requisição durante
    o bloqueio), e a mensagem de erro passou a incluir o `Retry-After` exato e o corpo do
    erro 500 — antes descartados.
11. **"Chamados em aberto" retornando chamados "Resolvido"**: o agente tentava excluir
    status via `$filter` OData (`ne`/`or`/`not`, operadores não confirmados nesta API).
    Corrigido com o parâmetro `only_open` em `searchTicketsExhaustive` — filtra
    `baseStatus` (enum confirmado: New/InAttendance/Stopped = aberto, Resolved/
    Canceled/Closed = não) no próprio código, depois de buscar, em vez de depender de
    sintaxe OData não testada.
12. **Conversa mais fluida em consultas amplas**: antes o agente ou executava buscas sem
    escopo claro (ex: "todos os chamados" sem período) ou fazia listas formais de
    esclarecimento. Agora, para consultas (nunca para criar/alterar chamado), pergunta
    status primeiro (aberto/finalizado/todos) e só pergunta período se o status não for
    "em aberto" — chamados em aberto são um recorte já limitado por natureza, então
    perguntar período nesse caso é fricção desnecessária (ex: "todos os chamados em
    aberto do serviço X" já tem status explícito e não precisa de nenhuma pergunta). Ver
    "Consultas amplas" no Passo A do prompt de sistema. A instrução original ficou
    embutida demais no meio do prompt e foi ignorada em teste real; promovida a regra em
    destaque logo no topo da seção 2 (Princípios obrigatórios) para ficar mais difícil de
    ser deprioritizada pelo modelo. Reforçado explicitamente: esse fluxo de consulta é só
    leitura, nunca dispara `movidesk_create_ticket`/`movidesk_patch_ticket` por conta
    própria.
13. **Exportação para PDF** (`src/local/pdfExport.ts`, via `pdfkit`): mesmo padrão já
    estabelecido para Excel — `export_tickets_search_to_pdf` busca e grava o arquivo
    inteiramente no servidor numa única chamada (nunca passa pelos tokens do modelo,
    evitando o mesmo bug de truncamento já corrigido no Excel); `export_tickets_to_pdf`
    existe só para linhas pequenas (até 200) já prontas na conversa. Limite de 5.000
    linhas (bem menor que o Excel) porque PDF é para relatório legível, não para
    descarregar bases inteiras.
14. **Download de arquivos pelo navegador**: os quatro export tools emitem um evento
    `file_ready` (`src/observability/eventBus.ts`) assim que gravam um arquivo. O painel
    (`src/server/dashboard.ts`) escuta esse evento e injeta um cartão de download na aba
    Conversa (independente do texto que o modelo escrever), e serve o arquivo via
    `GET /exports/:filename` (sempre `path.basename()` do nome pedido — nunca sai de
    `EXPORTS_DIR`, mesmo com tentativa de path traversal). `DashboardHandle` ganhou um
    método `close()` para encerrar o servidor de forma limpa (usado pelos testes).

## 9. Limitações conhecidas

- **Stores em arquivo, não banco real**: auditoria, idempotência e diretórios locais são
  JSON/JSONL em disco — adequado para 1 processo/uso local, não para múltiplas réplicas
  em produção.
- **AD real não implementado**: `src/local/directory.ts` tem só um adapter mock; o
  adapter LDAP real lança "não implementado" propositalmente.
- **Painel web sem autenticação**: pensado para rodar em `localhost` na máquina do
  próprio usuário. Não exponha a porta do painel (`DASHBOARD_PORT`) em rede não confiável.
- **`/tickets/past`**: sintaxe assumida por analogia com `/tickets`, não confirmada em
  documentação oficial detalhada.
- **Filtro de tickets por organização**: usa `clients/any(client: client/organization/id
  eq '...')` como tentativa fundamentada (campos confirmados individualmente, combinação
  ainda não 100% testada em todos os cenários).

## 10. Para estender

- **Novo fluxo de negócio**: siga a seção 12 do prompt de sistema (extrair metadados de
  1-3 chamados reais, nunca copiar dados pessoais de exemplo) e adicione a entrada em
  `src/config/tenant.ts`.
- **Nova ferramenta**: adicione o schema em `src/agent/tools.ts`, o case no
  `dispatchToolInner`, e registre a definição JSON em `src/agent/orchestrator.ts`
  (`TOOL_PARAMETERS`). Documente no prompt de sistema (seção 4).
- **Trocar o provedor de LLM**: só `src/agent/orchestrator.ts` muda — o contrato de
  ferramentas (`tools.ts`) é agnóstico de provedor.
