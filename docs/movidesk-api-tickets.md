# Movidesk API — Requisições, endpoints e como utilizar

> Baseado na documentação de API do Movidesk fornecida internamente.
>
> **Base URL:** `https://api.movidesk.com/public/v1`
>
> **Importante:** nunca coloque o token real em documentação, código versionado ou prints. Nos exemplos abaixo use sempre `<MOVIDESK_TOKEN>`.

---

## 1. Visão geral

A documentação fornecida descreve principalmente a API de **Tickets** do Movidesk.

### Endpoints documentados

| Finalidade | Método | Endpoint |
|---|---|---|
| Consultar um ticket por ID ou protocolo | `GET` | `/tickets` |
| Listar tickets | `GET` | `/tickets` |
| Filtrar/ordenar/paginar tickets | `GET` | `/tickets` |
| Obter HTML das ações de um ticket | `GET` | `/tickets/htmldescription` |
| Criar ticket | `POST` | `/tickets` |
| Atualizar ticket parcialmente | `PATCH` | `/tickets` |
| Enviar anexos para uma ação | `POST` | `/ticketFileUpload` |
| Consultar tickets antigos | rota indicada | `/tickets/past` |

> A documentação informa que `/tickets` retorna tickets cuja `lastUpdate` é inferior a 90 dias. Para tickets com atualização mais antiga, deve-se utilizar `/tickets/past`. O material fornecido apenas indica essa rota e remete à documentação específica; ele não detalha no mesmo nível os parâmetros e exemplos de `/tickets/past`.

---

## 2. Autenticação

O token é enviado como parâmetro de query string:

```text
?token=<MOVIDESK_TOKEN>
```

Exemplo:

```http
GET https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123
```

### Geração do token

Segundo a documentação:

1. Acesse o Movidesk.
2. Vá em **Configurações > Conta > Parâmetros**.
3. Na guia **Ambiente**, gere uma nova chave para a API.

A geração de uma nova chave invalida a chave anterior. Portanto, integrações que ainda utilizem a chave antiga deixam de funcionar.

---

## 3. Limites e bloqueios

A documentação informa:

- Limite geral de **10 requisições por minuto**.
- Na API de Tickets, após **3 requisições com erro**, a API pode responder:
  - `429 - Too many failed requests`
  - bloqueio por **60 segundos**.
- Se ocorrerem mais 3 tentativas com erro:
  - bloqueio por **120 segundos**.
- Após mais 3 tentativas com erro:
  - bloqueio por **300 segundos**.
- O header `retry-after` informa quanto tempo falta para novas requisições serem permitidas.

### Recomendação de integração

Ao receber `429`:

1. leia o header `retry-after`;
2. não faça novas tentativas durante o período informado;
3. aplique retry/backoff;
4. registre o erro que originou as tentativas para não repetir uma chamada inválida indefinidamente.

---

# 4. GET `/tickets` — obter um único ticket

Use quando você já conhece o **ID** ou o **protocolo**.

## Por ID

```bash
curl --request GET \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123'
```

## Por protocolo

```bash
curl --request GET \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&protocol=MOVI202109000001'
```

## Parâmetros

| Parâmetro | Obrigatório | Descrição |
|---|---:|---|
| `token` | sim | Token da API |
| `id` | um entre `id`/`protocol` | Número do ticket |
| `protocol` | um entre `id`/`protocol` | Protocolo do ticket |
| `includeDeletedItems` | não | Se `true`, inclui itens associados que foram deletados, como ações, clientes, tickets pais e filhos |

Exemplo:

```http
GET /tickets?token=<MOVIDESK_TOKEN>&id=123&includeDeletedItems=true
```

### Observação sobre campos adicionais

A propriedade `customFieldValues` retorna apenas campos adicionais cujas regras de exibição estejam sendo atendidas no momento da consulta.

---

# 5. GET `/tickets` — listar tickets

Na listagem, a documentação informa que é **obrigatório usar `$select`**.

Exemplo:

```bash
curl --request GET \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&$select=id,type,origin,status'
```

Resposta conceitual:

```json
[
  {
    "id": 1,
    "type": 2,
    "origin": 9,
    "status": "Novo"
  },
  {
    "id": 2,
    "type": 2,
    "origin": 9,
    "status": "Novo"
  }
]
```

---

# 6. GET `/tickets` — filtros OData

A API usa recursos do padrão **OData** para filtrar, ordenar, paginar e expandir dados.

## Operadores suportados pela documentação

| Operador | Uso |
|---|---|
| `$filter` | Filtra os itens |
| `$orderby` | Ordena o retorno |
| `$top` | Limita a quantidade de itens |
| `$skip` | Ignora uma quantidade de itens; útil para paginação |
| `$select` | Escolhe quais propriedades retornar |
| `$expand` | Expande objetos/coleções relacionadas |

> A documentação alerta que somente essas palavras-chave são suportadas. Por exemplo, `$count` não está disponível.

---

## 6.1 Filtrar por data

Tickets criados após uma data:

```http
GET /tickets
  ?token=<MOVIDESK_TOKEN>
  &$select=id,subject,createdDate
  &$filter=createdDate gt 2016-09-01T00:00:00.00z
```

Em uma URL real, faça o encoding adequado dos espaços e caracteres reservados.

---

## 6.2 Ordenar

Exemplo: ordenar por ID em ordem decrescente:

```http
GET /tickets
  ?token=<MOVIDESK_TOKEN>
  &$select=id,subject,createdDate
  &$filter=createdDate gt 2016-09-01T00:00:00.00z
  &$orderby=id desc
```

---

## 6.3 Paginar com `$top` e `$skip`

Segunda página de 100 registros:

```http
GET /tickets
  ?token=<MOVIDESK_TOKEN>
  &$select=id,subject,createdDate
  &$orderby=id desc
  &$top=100
  &$skip=100
```

Lógica:

- página 1: `$top=100&$skip=0`
- página 2: `$top=100&$skip=100`
- página 3: `$top=100&$skip=200`

---

## 6.4 Filtrar intervalo de datas

```text
$filter=createdDate ge 2016-10-10T00:00:00.00z and createdDate le 2016-10-17T00:00:00.00z
```

---

## 6.5 Expandir objetos relacionados

A documentação apresenta expansão de responsável, ações, apontamentos e geradores.

Exemplo conceitual:

```text
$expand=owner,actions($select=origin,id),actions($expand=timeAppointments($expand=createdBy))
```

Exemplo completo:

```http
GET /tickets
  ?token=<MOVIDESK_TOKEN>
  &$select=id,subject,createdDate
  &$filter=createdDate ge 2016-10-10T00:00:00.00z and createdDate le 2016-10-17T00:00:00.00z
  &$expand=owner,actions($select=origin,id),actions($expand=timeAppointments($expand=createdBy))
```

---

## 6.6 Filtrar por item de coleção

Exemplo documentado: tickets em que qualquer cliente tenha determinado ID.

```text
$filter=clients/any(client: client/id eq '1')
```

Exemplo:

```http
GET /tickets
  ?token=<MOVIDESK_TOKEN>
  &$filter=clients/any(client: client/id eq '1')
  &$select=id
  &$expand=clients
```

---

## 6.7 Filtrar por propriedade de navegação singular (não documentado, confirmado ao vivo)

A doc pública só documenta filtro por coleção (`clients/any(...)`, seção 6.6). Para uma
propriedade de navegação **singular** como `owner`, testamos ao vivo (2026-08-31, tenant
VIASOFT) e `owner/id eq '<COD_REF>'` **funciona** — devolve exatamente os mesmos tickets
que filtrar `owner.id` localmente após buscar por status, só que numa única chamada em
vez de paginar a base inteira. `owner.id eq '...'` (ponto) e `ownerId eq '...'` (campo
escalar) foram testados e devolvem 400 — só a sintaxe com barra (`owner/id`), igual ao
padrão de `any()`, é aceita.

```text
$filter=status eq 'Aguardando' and owner/id eq '57991'
```

Não testado para outras propriedades de navegação singular (ex: `createdBy/id`) — não
assuma que funciona por analogia sem confirmar da mesma forma.

---

# 7. GET `/tickets/htmldescription` — HTML de uma ação

Na leitura normal:

- `description` retorna texto;
- `htmlDescription` só é retornado em condições específicas;
- para obter explicitamente o HTML de uma ação, use `/tickets/htmldescription`.

## Por ID do ticket

```bash
curl --request GET \
  'https://api.movidesk.com/public/v1/tickets/htmldescription?token=<MOVIDESK_TOKEN>&id=123&actionId=1'
```

## Parâmetros

| Parâmetro | Uso |
|---|---|
| `token` | Autenticação |
| `id` ou `protocol` | Identifica o ticket |
| `actionId` | Opcional; identifica a ação específica |

Resposta conceitual:

```json
{
  "id": 1,
  "description": "<h1>title</h1><br><p>some text from action</p>"
}
```

---

# 8. POST `/tickets` — criar ticket

## Requisição

```bash
curl --request POST \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&returnAllProperties=false' \
  --header 'Content-Type: application/json' \
  --data '{
    "type": 2,
    "subject": "Assunto",
    "category": "Categoria",
    "urgency": "Urgência",
    "status": "Novo",
    "createdBy": {
      "id": "<COD_REF_SOLICITANTE>"
    },
    "clients": [
      {
        "id": "<COD_REF_CLIENTE>"
      }
    ],
    "actions": [
      {
        "type": 2,
        "description": "Descrição inicial do ticket"
      }
    ]
  }'
```

## Parâmetros

| Parâmetro | Obrigatório | Descrição |
|---|---:|---|
| `token` | sim | Token da API |
| `returnAllProperties` | não | Valor padrão `false`; controla o retorno de propriedades |

## Header

```http
Content-Type: application/json
```

## Retorno

A documentação informa:

- `HTTP 200`
- por padrão, o corpo contém o **ID do ticket criado**.

---

# 9. PATCH `/tickets` — atualizar ticket

O `PATCH` é **parcial**: envie somente os campos que deseja alterar.

## Exemplo — alterar assunto

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "subject": "Novo assunto"
  }'
```

Retorno esperado:

```text
HTTP 200
```

---

## 9.1 Regra crítica: listas sobrescrevem o conteúdo anterior

Embora o `PATCH` seja parcial para campos simples, **listas/objetos filhos enviados sobrescrevem os itens existentes da lista**.

Exemplo: limpar tags.

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "tags": []
  }'
```

Isso remove todas as tags.

### Atenção

Antes de alterar coleções como clientes, ações, apontamentos ou campos adicionais, consulte o ticket atual e preserve os itens que devem continuar existindo.

---

## 9.2 Ações e apontamentos: ID define atualizar ou inserir

Segundo a documentação:

- se uma ação/apontamento existente for enviado com `id`, a API entende como **alteração**;
- se não houver `id` ou ele for zero, a API entende como **inserção**.

Exemplo conceitual de adicionar nova ação:

```json
{
  "actions": [
    {
      "type": 2,
      "description": "Nova interação registrada via API"
    }
  ]
}
```

Se a integração também precisar manter ações já existentes no array enviado, deve respeitar a regra de sobrescrita descrita na documentação.

---

## 9.3 Clientes e apontamentos omitidos podem ser excluídos

A documentação alerta especificamente que, nas listas de **clientes** e **apontamentos**, os itens que já estão salvos e não forem enviados no corpo podem ser excluídos.

Portanto:

1. faça um `GET` do estado atual;
2. monte a coleção completa desejada;
3. envie o `PATCH`.

---

# 10. POST `/ticketFileUpload` — anexar arquivo em uma ação

O upload é feito em endpoint separado.

## Requisição

```bash
curl --request POST \
  'https://api.movidesk.com/public/v1/ticketFileUpload?token=<MOVIDESK_TOKEN>&id=123&actionId=1' \
  --header 'Content-Type: multipart/form-data' \
  --form 'file=@/caminho/arquivo.pdf'
```

> O nome exato do campo multipart pode depender da biblioteca/implementação. A documentação fornecida descreve o corpo como "anexos" e o `Content-Type` como `multipart/form-data`.

## Parâmetros

| Parâmetro | Obrigatório | Descrição |
|---|---:|---|
| `token` | sim | Token da API |
| `id` | sim | ID do ticket existente |
| `actionId` | sim | ID da ação existente |

## Retorno

- `HTTP 200`
- corpo com detalhes dos arquivos enviados, incluindo nomes, hashes e eventuais erros.

---

# 11. `/tickets/past` — tickets com mais de 90 dias desde a atualização

A documentação informa:

- `/tickets` considera tickets com `lastUpdate` inferior a 90 dias;
- tickets mais antigos devem ser buscados em `/tickets/past`.

Como o material fornecido não detalha a sintaxe completa dessa rota, não é seguro assumir automaticamente todos os mesmos parâmetros sem validar a documentação específica da API Past.

---

# 12. Modelo do objeto Ticket

A seguir estão os principais campos documentados.

## 12.1 Campos gerais

| Campo | Tipo | Escrita | Observação |
|---|---|---|---|
| `id` | string/int | leitura | Número do ticket |
| `protocol` | string | leitura | Protocolo |
| `type` | int | sim | `1 = Interno`, `2 = Público` |
| `subject` | string | sim | Assunto |
| `category` | string | sim | Deve existir e ser compatível com tipo/serviço |
| `urgency` | string | sim | Deve existir e estar relacionada à categoria |
| `status` | string | sim | Para alterar, informe também `justification` quando exigido |
| `baseStatus` | string | leitura | `New`, `InAttendance`, `Stopped`, `Canceled`, `Resolved`, `Closed` |
| `justification` | string | sim | Deve ser válida para o status |
| `origin` | int | leitura | Canal de abertura |
| `createdDate` | datetime UTC | criação | Se omitida na criação, usa a data atual; depois é leitura |
| `originEmailAccount` | string | leitura | Conta que recebeu o e-mail |
| `owner` | person | sim | Para alterar, informe também `ownerTeam` |
| `ownerTeam` | string | sim | Deve ser compatível com o responsável |
| `createdBy` | person | criação | Gerador do ticket |
| `serviceFull` | array | leitura | Níveis do serviço |
| `serviceFirstLevelId` | int | sim | ID do serviço |
| `serviceFirstLevel` | string | leitura | Primeiro nível |
| `serviceSecondLevel` | string | leitura | Segundo nível |
| `serviceThirdLevel` | string | leitura | Terceiro nível |
| `contactForm` | string | leitura | Formulário de contato |
| `tags` | array | sim | Tags inexistentes podem ser criadas |
| `cc` | string | leitura | E-mails em cópia |
| `sequence` | int | sim | Sequência |
| `slaSolutionDate` | datetime UTC | sim | Pode marcar alteração manual do SLA |
| `clients` | array | sim | Clientes do ticket |
| `actions` | array | sim | Ações do ticket |
| `parentTickets` | array | leitura/estrutura | Tickets pais |
| `childrenTickets` | array | leitura/estrutura | Tickets filhos |
| `ownerHistories` | array | leitura | Histórico de responsáveis |
| `statusHistories` | array | leitura | Histórico de status |
| `customFieldValues` | array | sim | Campos adicionais |
| `assets` | array | leitura | Ativos relacionados |

Há diversos campos de SLA, datas, chat e métricas marcados como somente leitura, como `lastUpdate`, `lastActionDate`, `slaAgreement`, `slaResponseDate`, `slaRealResponseDate`, `stoppedTime` e outros.

---

# 13. Status e justificativa

Regra importante:

- `status` deve ser um status existente e compatível com o tipo do ticket;
- quando o status exige justificativa, `justification` é obrigatória;
- para alterar a justificativa, a documentação orienta também informar o status.

Exemplo conceitual:

```json
{
  "status": "Resolvido",
  "justification": "Problema solucionado"
}
```

> Use os nomes reais cadastrados no seu ambiente Movidesk.

---

# 14. Responsável e equipe

Para alterar o responsável:

- envie `owner`;
- envie também `ownerTeam`;
- a equipe precisa estar associada ao responsável informado.

Exemplo:

```json
{
  "owner": {
    "id": "<COD_REF_RESPONSAVEL>"
  },
  "ownerTeam": "Equipe de Suporte"
}
```

---

# 15. Clientes

Estrutura documentada de `clients`:

```json
{
  "clients": [
    {
      "id": "<COD_REF_CLIENTE>"
    }
  ]
}
```

Na leitura, o objeto também pode conter:

```json
{
  "id": "<COD_REF_CLIENTE>",
  "businessName": "Nome do cliente",
  "email": "cliente@empresa.com",
  "phone": "(00) 00000-0000",
  "personType": 1,
  "profileType": 2,
  "isDeleted": false,
  "organization": {
    "id": "<COD_REF_ORGANIZACAO>"
  }
}
```

### `personType`

- `1`: Pessoa
- `2`: Empresa
- `4`: Departamento

### `profileType`

- `1`: Agente
- `2`: Cliente
- `3`: Agente e Cliente

---

# 16. Ações

Estrutura principal:

```json
{
  "actions": [
    {
      "id": 1,
      "type": 2,
      "description": "Descrição da ação"
    }
  ]
}
```

## Campos relevantes

| Campo | Observação |
|---|---|
| `id` | Informe quando for alterar uma ação existente |
| `type` | `1 = Interna`, `2 = Pública` |
| `description` | Na escrita, é interpretada como HTML |
| `htmlDescription` | Somente leitura; HTML da ação |
| `status` | Somente leitura dentro da ação |
| `justification` | Somente leitura dentro da ação |
| `createdDate` | UTC; se não enviada, usa data atual |
| `createdBy` | Obrigatório quando houver apontamentos na criação/alteração |
| `timeAppointments` | Apontamentos de hora |
| `expenses` | Despesas |
| `attachments` | Anexos |
| `tags` | Tags da ação |

### HTML na descrição

Em operações de escrita, `description` é interpretada como HTML.

Exemplo:

```json
{
  "actions": [
    {
      "type": 2,
      "description": "<p>Atualização enviada pela integração.</p>"
    }
  ]
}
```

---

# 17. Apontamentos de horas

Estrutura: `actions[n].timeAppointments[n]`

Principais campos:

| Campo | Obrigação/uso |
|---|---|
| `id` | Usado para alterar apontamento existente |
| `activity` | Atividade previamente cadastrada |
| `date` | Data com horas zeradas, ex.: `2016-08-24T00:00:00` |
| `periodStart` | Horário inicial, quando exigido |
| `periodEnd` | Horário final, quando exigido |
| `workTime` | Tempo total, quando exigido |
| `accountedTime` | Somente leitura |
| `workTypeName` | Tipo do horário |
| `createdBy` | Gerador do apontamento |
| `createdByTeam` | Time do gerador, quando aplicável |

Exemplo conceitual:

```json
{
  "actions": [
    {
      "id": 1,
      "type": 2,
      "description": "Atendimento realizado",
      "timeAppointments": [
        {
          "activity": "Atendimento",
          "date": "2026-08-26T00:00:00",
          "periodStart": "09:00:00",
          "periodEnd": "10:00:00",
          "workTime": "01:00:00",
          "workTypeName": "Normal",
          "createdBy": {
            "id": "<COD_REF_AGENTE>"
          }
        }
      ]
    }
  ]
}
```

Use os nomes de atividade e tipo de horário cadastrados na sua conta.

---

# 18. Despesas

Estrutura: `actions[n].expenses[n]`

Campos documentados:

- `id`
- `type`
- `serviceReport`
- `createdBy`
- `createdByTeam`
- `date`
- `quantity`
- `value`

Regra:

- informe `quantity` ou `value`, conforme o tipo de lançamento;
- `date` deve estar em UTC e não pode ser futura.

Exemplo conceitual:

```json
{
  "expenses": [
    {
      "type": "Transporte",
      "createdBy": {
        "id": "<COD_REF_AGENTE>"
      },
      "date": "2026-08-26T14:00:00Z",
      "value": 145.11
    }
  ]
}
```

---

# 19. Campos adicionais (`customFieldValues`)

Estrutura:

```json
{
  "customFieldValues": [
    {
      "customFieldId": 1,
      "customFieldRuleId": 1,
      "line": 1,
      "value": "texto via API",
      "items": []
    }
  ]
}
```

## Campos

| Campo | Descrição |
|---|---|
| `customFieldId` | ID do campo adicional |
| `customFieldRuleId` | ID da regra de exibição |
| `line` | Linha da regra |
| `value` | Valor para tipos simples |
| `items` | Itens para listas/seleções |

### Atenção: sobrescrita/exclusão

A documentação informa que os campos adicionais existentes que não forem enviados no corpo podem ser excluídos, conforme a regra/linha envolvida.

### Formato do `value`

Para campos de data:

```text
YYYY-MM-DDThh:MM:ss.000Z
```

Para campo de hora, a documentação indica usar a data fixa:

```text
1991-01-01
```

Para campo numérico, o formato documentado é brasileiro, por exemplo:

```text
1.530,75
```

---

## 19.1 Itens de campos adicionais

Estrutura de `items`:

```json
{
  "items": [
    {
      "personId": null,
      "clientId": null,
      "team": null,
      "customFieldItem": "Opção A"
    }
  ]
}
```

Use:

- `personId` para lista de pessoas;
- `clientId` para lista de clientes;
- `team` para lista de agentes/equipes;
- `customFieldItem` para lista de valores, seleção única ou múltipla.

---

# 20. Tags

No ticket:

```json
{
  "tags": [
    "Integracao",
    "Prioridade"
  ]
}
```

A documentação informa que tags inexistentes podem ser adicionadas à base.

Para remover todas:

```json
{
  "tags": []
}
```

---

# 21. Tickets pais e filhos

Estrutura de leitura:

```json
{
  "parentTickets": [
    {
      "id": 2,
      "subject": "Ticket pai",
      "isDeleted": false
    }
  ],
  "childrenTickets": [
    {
      "id": 3,
      "subject": "Ticket filho",
      "isDeleted": false
    }
  ]
}
```

---

# 22. Históricos

## Histórico de responsabilidade

`ownerHistories[n]` pode retornar:

- `ownerTeam`
- `owner`
- `permanencyTimeFullTime`
- `permanencyTimeWorkingTime`
- `changedBy`
- `changedDate`

## Histórico de status

`statusHistories[n]` pode retornar:

- `status`
- `justification`
- `permanencyTimeFullTime`
- `permanencyTimeWorkingTime`
- `changedBy`
- `changedDate`

---

# 23. Pesquisa de satisfação

A documentação informa que `satisfactionSurveyResponses` na API de Tickets está **depreciada** e não deve mais ser considerada a fonte de respostas.

O Movidesk criou uma API específica de **Pesquisa de satisfação — Respostas**.

Portanto, para novas integrações:

- não dependa de `ticket.satisfactionSurveyResponses`;
- use a API específica de pesquisa de satisfação.

---

# 24. Ativos

`assets[n]` é descrito como somente leitura e pode retornar:

- `id`
- `name`
- `label`
- `serialNumber`
- níveis de categoria
- `isDeleted`

---

# 25. Datas e UTC

A documentação usa UTC para datas.

Exemplo:

```text
2026-08-26T14:30:00Z
```

Se o horário local for Brasília (`UTC-03:00`):

```text
15:30 local = 18:30 UTC
```

Ao integrar:

1. normalize datas para UTC;
2. não envie horários locais sem offset;
3. ao exibir para usuários, converta de UTC para o timezone desejado.

---

# 26. Origem do ticket

`origin` é somente leitura.

Valores documentados incluem:

| Código | Origem |
|---:|---|
| `1` | Via web pelo cliente |
| `2` | Via web pelo agente |
| `3` | Recebido via e-mail |
| `4` | Gatilho do sistema |
| `5` | Chat online |
| `7` | E-mail enviado pelo sistema |
| `8` | Formulário de contato |
| `9` | Via Web API |
| `10` | Agendamento automático |
| `11` | JiraIssue |
| `12` | RedmineIssue |
| `13` | Chamada recebida |
| `14` | Chamada realizada |
| `15` | Chamada perdida |
| `16` | Desistência de chamada |
| `17` | Acesso remoto |
| `18` | WhatsApp |
| `19` | MovideskIntegration |
| `20` | ZenviaChat |
| `21` | Chamada não atendida |
| `22` | Facebook Messenger |
| `23` | WhatsApp Business Movidesk |
| `24` | Altu |
| `25` | WhatsApp Ativo |

---

# 27. Exemplo completo de consulta incremental

Uma estratégia típica para integrações é consultar registros atualizados recentemente.

Exemplo conceitual:

```bash
curl --get \
  'https://api.movidesk.com/public/v1/tickets' \
  --data-urlencode 'token=<MOVIDESK_TOKEN>' \
  --data-urlencode '$select=id,protocol,subject,status,lastUpdate' \
  --data-urlencode '$filter=lastUpdate ge 2026-08-26T00:00:00.00z' \
  --data-urlencode '$orderby=lastUpdate asc' \
  --data-urlencode '$top=100' \
  --data-urlencode '$skip=0'
```

> O material fornecido documenta OData e o campo `lastUpdate`; valide o comportamento final no ambiente antes de usar em produção.

---

# 28. Exemplo de atualização de status

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "status": "Resolvido",
    "justification": "Solução aplicada"
  }'
```

Os textos de status e justificativa precisam existir e ser compatíveis no seu ambiente.

---

# 29. Exemplo de troca de responsável

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "owner": {
      "id": "<COD_REF_RESPONSAVEL>"
    },
    "ownerTeam": "Equipe de Suporte"
  }'
```

---

# 30. Exemplo de adicionar ação pública

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "actions": [
      {
        "type": 2,
        "description": "<p>Atualização realizada pela integração.</p>"
      }
    ]
  }'
```

> **Cuidado:** ações fazem parte de uma lista. A documentação do PATCH alerta que listas enviadas sobrescrevem o conteúdo da lista. Valide em ambiente de teste e preserve os itens necessários.

---

# 31. Exemplo de atualizar campo adicional

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/tickets?token=<MOVIDESK_TOKEN>&id=123' \
  --header 'Content-Type: application/json' \
  --data '{
    "customFieldValues": [
      {
        "customFieldId": 100,
        "customFieldRuleId": 20,
        "line": 1,
        "value": "Novo valor",
        "items": []
      }
    ]
  }'
```

Antes de usar:

1. descubra `customFieldId`;
2. descubra `customFieldRuleId`;
3. confirme a `line`;
4. preserve outros campos que devam continuar gravados.

---

# 32. Boas práticas para produção

1. **Nunca exponha o token.**
2. **Respeite 10 requisições/minuto.**
3. **Implemente backoff para 429** usando `retry-after`.
4. **Use URL encoding** nos parâmetros OData.
5. **Use `$select`** nas listagens.
6. **Use paginação** com `$top` e `$skip`.
7. **Trabalhe com UTC**.
8. **Antes de PATCH em listas, faça GET do estado atual.**
9. **Não invente status, justificativas, categorias, urgências, atividades ou equipes**: use valores realmente cadastrados no ambiente.
10. **Teste PATCH de ações, clientes, apontamentos e campos adicionais em homologação**, pois a sobrescrita de listas pode remover dados.
11. **Considere atraso de replicação**: a documentação alerta que tickets, usuários e outros registros novos/alterados podem levar alguns minutos para aparecer nas pesquisas.
12. **Para tickets antigos**, use a rota `/tickets/past` e valide a documentação específica dessa API.
13. **Não use `satisfactionSurveyResponses` como integração nova**, pois o recurso na API de Tickets está depreciado.

---

# 33. Checklist rápido por operação

## Consultar ticket

```text
GET /tickets
token + id/protocol
```

## Listar tickets

```text
GET /tickets
token + $select
```

## Filtrar tickets

```text
GET /tickets
token + $select + $filter
opcionais: $orderby, $top, $skip, $expand
```

## Obter HTML de ação

```text
GET /tickets/htmldescription
token + id/protocol
opcional: actionId
```

## Criar ticket

```text
POST /tickets
token
opcional: returnAllProperties
Content-Type: application/json
body: JSON do ticket
```

## Atualizar ticket

```text
PATCH /tickets
token + id
Content-Type: application/json
body: somente campos desejados
ATENÇÃO: listas sobrescrevem coleções
```

## Enviar anexo

```text
POST /ticketFileUpload
token + id + actionId
Content-Type: multipart/form-data
body: arquivo(s)
```

## Consultar ticket antigo

```text
/tickets/past
Usar para tickets cuja lastUpdate seja superior ao recorte de 90 dias.
Validar os detalhes na documentação específica da rota.
```

---

# 34. Referências informadas na documentação fornecida

- Base da API: `https://api.movidesk.com/public/v1`
- API de Tickets: documentação de Ticket API do Movidesk
- API de tickets antigos: documentação de `/tickets/past`
- API de pesquisa de satisfação: documentação específica de respostas de satisfação
- Limites e horários da API: documentação de horário e limite de acesso

---

## 35. Resumo final

A integração de Tickets do Movidesk segue este padrão:

```text
Leitura:
GET /tickets
GET /tickets/htmldescription

Criação:
POST /tickets

Alteração:
PATCH /tickets

Arquivos:
POST /ticketFileUpload

Tickets antigos:
consulta específica em /tickets/past
```

O maior cuidado técnico é o comportamento do `PATCH`: campos simples são parciais, mas listas enviadas podem sobrescrever coleções existentes. Sempre faça leitura prévia antes de alterar clientes, ações, apontamentos, tags ou campos adicionais.
