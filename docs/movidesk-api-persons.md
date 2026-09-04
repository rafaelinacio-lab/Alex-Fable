# Movidesk API — Persons (Pessoas e Organizações)

> Documentação de referência para o endpoint `/persons` da API pública Movidesk.
>
> **Base URL:** `https://api.movidesk.com/public/v1`
>
> **Autenticação:** `?token=<MOVIDESK_TOKEN>` na query string (mesma convenção dos outros endpoints).
>
> **Importante:** o Movidesk **não usa path REST** para identificar registros. O identificador vai na query string: `GET /persons?id=COD_REF`, nunca `/persons/COD_REF`.

---

## 1. Visão geral

O endpoint `/persons` abrange **pessoas físicas** (personType=1), **empresas/organizações** (personType=2) e **departamentos** (personType=4). Um mesmo cadastro pode ter perfil de **Agente** (1), **Cliente** (2) ou **Agente e Cliente** (3) via `profileType`.

### Métodos documentados

| Método | Endpoint | Finalidade |
|---|---|---|
| `GET` | `/persons` | Consultar uma pessoa por ID ou listar/filtrar |
| `POST` | `/persons` | Criar pessoa ou organização |
| `PATCH` | `/persons` | Atualizar parcialmente |
| `DELETE` | `/persons` | Excluir (requer permissão administrativa) |

---

## 2. GET `/persons` — consultar uma pessoa

### Por ID (cod_ref)

```http
GET /persons?token=<MOVIDESK_TOKEN>&id=COD_REF
```

`id` é o **código de referência** alfanumérico da pessoa. Retorna um único objeto.

### Parâmetros opcionais na consulta por ID

| Parâmetro | Descrição |
|---|---|
| `$select` | Campos a retornar |
| `$expand` | Expandir propriedades de navegação (ver seção 5) |

---

## 3. GET `/persons` — listar e filtrar (OData)

`$select` é obrigatório neste endpoint (a API pode retornar 400 sem ele para listagens).

Exemplo básico:

```http
GET /persons?token=<MOVIDESK_TOKEN>&$select=id,businessName,personType&$top=50
```

### Parâmetros OData suportados

| Parâmetro | Notas |
|---|---|
| `$filter` | Filtros OData (ver seção 4) |
| `$select` | **Obrigatório em listagens** |
| `$orderby` | ex: `businessName asc` |
| `$top` | Limite por página. Conservador: use 100. Pode aceitar até 500 (não confirmado). |
| `$skip` | Paginação: `$skip=100` para a segunda página de 100. |
| `$expand` | Propriedades de navegação (ver seção 5) |

> **Sem `$count`:** a API não suporta `$count`. Para contar registros, pagine até o fim.

---

## 4. Filtros OData em `/persons` — confirmados e proibidos

### ✅ Confirmados (testados neste tenant)

| Padrão | Exemplo |
|---|---|
| `personType eq N` | `personType eq 2` (só empresas) |
| `businessName contains '...'` | `contains(businessName,'Viasoft')` |
| `cpfCnpj eq '...'` | `cpfCnpj eq '55677448000136'` ou `cpfCnpj eq '55.677.448/0001-36'` |
| `isActive eq true` / `false` | `isActive eq true` |
| `relationships/any(r: r/id eq 'COD_REF')` | Filtrar pessoas por organização vinculada — **padrão confirmado via curl** |

### ❌ Proibidos / retornam HTTP 400

| Padrão | Motivo |
|---|---|
| `organization/id eq 'X'` | **HTTP 400 confirmado** (logs prod, 2026-09-04) — esse caminho de navegação NÃO é suportado como filtro em `/persons`. |
| `id eq 'COD_REF'` | **HTTP 400 confirmado** (logs prod, 2026-09-04) — `id` não é filtrável via OData `$filter`. Quando o ID é conhecido, use `GET /persons?id=COD_REF` (não `$filter=id eq 'X'`). |
| `email` em `$select` (sem expand) | **HTTP 400 ou dado ausente** — `emails` é uma **coleção** (propriedade de navegação), não campo escalar. Exige `$expand=emails`. Incluir `email` em `$select` sem expand gera 400 ou retorna nulo. |
| `organization` em `$select` (sem expand) | **Dado ausente / possível 400** — `organization` é propriedade de navegação; exige `$expand=organization`. |
| `customFieldValues/any(...)` | Não confirmado para `/persons`; use `movidesk_search_persons_by_custom_field` em vez disso. |

### ⚠️ Não confirmados (não testar em produção sem validar)

| Padrão | Motivo |
|---|---|
| Operadores `ne`, `or`, `not` | Não foram confirmados para `/persons` |
| `emails/any(e: e/email eq '...')` | Filtro por e-mail via coleção — não testado; prefira buscar por `businessName` ou `cpfCnpj` |

---

## 5. Propriedades de navegação (`$expand`)

Estas propriedades **não aparecem via `$select` puro** — é obrigatório incluí-las em `$expand`:

| Campo | Para que serve | Valor no `expand` |
|---|---|---|
| `relationships` | Vínculos com organizações (confirmado via API real) | `"relationships"` |
| `emails` | Lista de e-mails da pessoa (coleção) | `"emails"` |
| `organization` | Organização mãe (campo singular) | `"organization"` |
| `customFieldValues` | Campos adicionais (ex: "Vertical Viasoft:") | `"customFieldValues"` |
| `addresses` | Endereços cadastrados | `"addresses"` |
| `phones` | Telefones (quando aplicável) | `"phones"` |

Múltiplos: `$expand=relationships,emails,customFieldValues`

> **Importante:** sem o `$expand`, esses campos chegam `null` ou ausentes. Ausência **não significa** campo não preenchido — é sempre falta do `$expand`.

---

## 6. Modelo do objeto Person

### Campos principais

| Campo | Tipo | Escrita | Observação |
|---|---|---|---|
| `id` | string | leitura | Código de referência alfanumérico |
| `codeReferenceAdditional` | string | sim | Código de referência adicional |
| `personType` | int | sim | `1`=Pessoa, `2`=Empresa, `4`=Departamento |
| `profileType` | int | sim | `1`=Agente, `2`=Cliente, `3`=Agente e Cliente |
| `businessName` | string | sim | Nome ou razão social |
| `cpfCnpj` | string | sim | CPF (pessoa) ou CNPJ (empresa) |
| `userName` | string | sim | Usuário (agentes) |
| `password` | string | criação | Senha inicial (agentes); nunca leia de volta |
| `role` | string | sim | Cargo/função |
| `bossId` | string | sim | cod_ref do superior (para agentes) |
| `bossName` | string | leitura | Nome do superior |
| `organization` | object | sim | Organização mãe: `{id: "COD_REF"}` |
| `organizationId` | string | sim | ID da organização mãe (escalar) |
| `relationships` | array | sim (com expand) | Vínculos com organizações |
| `emails` | array | sim (com expand) | Lista de e-mails |
| `phones` | array | sim | Lista de telefones |
| `addresses` | array | sim | Endereços |
| `customFieldValues` | array | sim | Campos adicionais |
| `isActive` | bool | sim | Ativo/inativo |
| `isDeleted` | bool | leitura | Excluído logicamente |
| `createdDate` | datetime | leitura | Data de criação |
| `lastUpdate` | datetime | leitura | Última atualização |

### Estrutura de `emails`

```json
[
  {
    "email": "pessoa@empresa.com",
    "emailType": "Comercial"
  }
]
```

### Estrutura de `relationships`

```json
[
  {
    "id": "COD_REF_ORG",
    "businessName": "Nome da Organização",
    "isDefault": true
  }
]
```

### Estrutura de `phones`

```json
[
  {
    "phoneType": "Comercial",
    "phone": "(41) 3333-4444",
    "extension": "123"
  }
]
```

---

## 7. POST `/persons` — criar pessoa/organização

```bash
curl --request POST \
  'https://api.movidesk.com/public/v1/persons?token=<MOVIDESK_TOKEN>' \
  --header 'Content-Type: application/json' \
  --data '{
    "personType": 1,
    "profileType": 2,
    "businessName": "Nome Completo",
    "cpfCnpj": "000.000.000-00",
    "emails": [
      { "email": "pessoa@empresa.com", "emailType": "Comercial" }
    ],
    "organization": {
      "id": "COD_REF_ORG"
    }
  }'
```

### Parâmetros de query

| Parâmetro | Descrição |
|---|---|
| `token` | Obrigatório |
| `returnAllProperties` | `false` (padrão) — retorna só o `id`; `true` — retorna o objeto completo |

### Retorno

- `HTTP 200` com o `id` (cod_ref) da pessoa criada (ou objeto completo se `returnAllProperties=true`).

> **Agente**: não há ferramenta para POST /persons neste projeto ainda. Se o usuário precisar criar um contato/organização, informe que essa operação ainda não está disponível via agente e oriente a fazer manualmente no Movidesk.

---

## 8. PATCH `/persons` — atualizar parcialmente

```bash
curl --request PATCH \
  'https://api.movidesk.com/public/v1/persons?token=<MOVIDESK_TOKEN>&id=COD_REF' \
  --header 'Content-Type: application/json' \
  --data '{
    "businessName": "Novo Nome",
    "isActive": false
  }'
```

### Regras críticas (mesmas do PATCH de tickets)

- Campos simples: PATCH parcial — envie apenas o que deseja alterar.
- **Coleções (emails, phones, addresses, relationships, customFieldValues): sobrescrevem** o conteúdo anterior. Sempre faça GET antes e envie a coleção completa com o que deseja manter.
- Retorno: `HTTP 200`.

> **Agente**: não há ferramenta para PATCH /persons neste projeto. Informe ao usuário que alterações de cadastro de pessoas/organizações devem ser feitas diretamente no Movidesk.

---

## 9. DELETE `/persons`

```http
DELETE /persons?token=<MOVIDESK_TOKEN>&id=COD_REF
```

- Exclusão lógica (marca `isDeleted: true`).
- Requer permissão administrativa.
- **Agente nunca deve executar DELETE de persons** — ver seção "Nunca faça automaticamente" do prompt de sistema.

---

## 10. Padrões confirmados de busca

### Buscar organização por CNPJ (cascata recomendada)

```
// Tentativa 1: dígitos puros
$filter=personType eq 2 and cpfCnpj eq '55677448000136'

// Tentativa 2: formato XX.XXX.XXX/XXXX-XX
$filter=personType eq 2 and cpfCnpj eq '55.677.448/0001-36'

// Tentativa 3: contains (fallback)
$filter=personType eq 2 and contains(cpfCnpj,'55677448000136')
```

> A ferramenta `movidesk_get_persons_in_organizations(org_cnpjs=[...])` já executa essa cascata automaticamente.

### Buscar pessoas de uma organização

```
$filter=relationships/any(r: r/id eq 'COD_REF_DA_ORG')
$expand=emails,relationships
$select=id,businessName,personType,profileType,isActive
```

> A ferramenta `movidesk_get_persons_in_organizations` já usa esse padrão.

### Buscar pessoas ativas de uma organização

```
$filter=relationships/any(r: r/id eq 'COD_REF_DA_ORG') and isActive eq true
$expand=emails,relationships
```

### Buscar organizações por nome

```
$filter=personType eq 2 and contains(businessName,'Nome da Empresa')
$select=id,businessName,cpfCnpj,personType
$top=20
```

### Buscar pessoa por e-mail (via coleção `emails` — não confirmado via OData)

Não há filtro OData confirmado para buscar por e-mail diretamente em `/persons`. O padrão atual é:
- Usar a tabela local `movidesk_contatos` via `find_movidesk_contact_by_email`.
- Ou buscar por nome/CNPJ e confirmar o e-mail no retorno expandido.

---

## 11. `customFieldValues` em Pessoas

O catálogo completo está em `docs/movidesk-custom-fields.md` (21 campos para Pessoa).

Campos mais utilizados para Pessoas:

| ID | Nome | Tipo |
|---|---|---|
| `29433` | Vertical Viasoft: | Seleção múltipla |

Para ler: `$expand=customFieldValues` — o array `customFieldValues[]` vem preenchido.

Para filtrar por campo adicional: use `movidesk_search_persons_by_custom_field` — OData `customFieldValues/any()` não está confirmado para `/persons`.

---

## 12. Paginação exaustiva

A API não suporta `$count`. Para obter todos os registros:

1. Página 1: `$top=100&$skip=0`
2. Página 2: `$top=100&$skip=100`
3. ...continua até página retornar menos de `$top` registros.

> A ferramenta `movidesk_get_persons_in_organizations` e `movidesk_search_persons_by_custom_field` já fazem paginação exaustiva automaticamente (com `maxPages` configurável).

---

## 13. Referências

- API de Pessoas (oficial): `https://atendimento.movidesk.com/kb/en/article/189/movidesk-person-api`
- Filtro `relationships/any()` confirmado: curl ao vivo no tenant Viasoft (2026-09-04)
- `organization/id eq 'X'` → HTTP 400: logs de produção Viasoft (2026-09-04, 22 ocorrências simultâneas)
