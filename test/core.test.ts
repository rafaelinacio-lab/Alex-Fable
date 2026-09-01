import "./setupEnv.js"; // precisa ser o primeiro import — ver comentário no arquivo

import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { odataEscape, buildQueryString, movideskHttp, MovideskApiError } from "../src/movidesk/client.js";
import { escapeHtml, validateSubject, searchTicketsExhaustive, BASE_STATUS } from "../src/movidesk/tickets.js";
import { buildIdempotencyKey, idempotencyReserve, idempotencyPut, idempotencyGet } from "../src/store/idempotency.js";
import { RateLimiter } from "../src/store/rateLimiter.js";
import { getFlowConfig } from "../src/config/tenant.js";
import { exportRowsToExcel } from "../src/local/export.js";
import { exportRowsToPdf } from "../src/local/pdfExport.js";
import { loadEnv } from "../src/config/loadEnv.js";
import { searchKnownServices, getKnownServiceById } from "../src/local/serviceCatalog.js";
import { startDashboardServer } from "../src/server/dashboard.js";
import { emitEvent, newEventId } from "../src/observability/eventBus.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { businessMinutesElapsed, businessDaysToMinutes, addBusinessMinutes, BUSINESS_MINUTES_PER_DAY, SLA_SCHEDULE } from "../src/movidesk/businessHours.js";
import { evaluateTicket, runFollowUpCheck } from "../src/agent/followUp.js";
import { decideAutoClose } from "../src/agent/followUpClose.js";
import {
  listFollowUpProfiles,
  createFollowUpProfile,
  updateFollowUpProfile,
  deleteFollowUpProfile,
  type FollowUpProfile,
} from "../src/config/followUpProfiles.js";

test("buildQueryString coloca id/protocol como parâmetro extra (não path) — regressão do bug de endpoint", () => {
  const qs = buildQueryString({ extra: { id: 123 } });
  assert.equal(qs, "id=123");

  const qsProtocol = buildQueryString({ extra: { protocol: "MOVI202109000001" } });
  assert.equal(qsProtocol, "protocol=MOVI202109000001");

  const qsCombined = buildQueryString({ select: ["id", "subject"], extra: { id: 1, returnAllProperties: false } });
  assert.equal(qsCombined, "%24select=id%2Csubject&id=1&returnAllProperties=false");
});

test("odataEscape dobra aspas simples", () => {
  assert.equal(odataEscape("O'Brien"), "O''Brien");
});

test("escapeHtml neutraliza tags e aspas", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("validateSubject rejeita assunto vazio e muito longo", () => {
  assert.throws(() => validateSubject(""));
  assert.throws(() => validateSubject("a".repeat(129)));
  assert.equal(validateSubject("ok"), "ok");
});

test("idempotência: reserva não duplica após sucesso", async () => {
  const dir = "./data/idempotency-test";
  rmSync(dir, { recursive: true, force: true });
  const key = buildIdempotencyKey({
    conversationId: "conv1",
    flow: "comite_ia",
    requesterId: "12345",
    normalizedFields: { subject: "Teste" },
  });

  const first = await idempotencyReserve(key, dir);
  assert.equal(first.status, "pending");

  await idempotencyPut({ ...first, status: "succeeded", result: { ticketId: 999 } }, dir);

  const second = await idempotencyReserve(key, dir);
  assert.equal(second.status, "succeeded");
  assert.deepEqual(second.result, { ticketId: 999 });

  const fetched = await idempotencyGet(key, dir);
  assert.equal(fetched?.status, "succeeded");

  rmSync(dir, { recursive: true, force: true });
});

test("RateLimiter permite N chamadas e enfileira a N+1", async () => {
  const windowMs = 200;
  const limiter = new RateLimiter(2, windowMs);
  const start = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire(); // deve esperar ~windowMs antes de resolver
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= windowMs - 20, `esperado esperar >= ${windowMs}ms, esperou ${elapsed}ms`);
});

test("getFlowConfig retorna config conhecida e rejeita fluxo inválido", () => {
  const cfg = getFlowConfig("comite_ia");
  assert.equal(cfg.serviceFirstLevelId, 1171844);
  assert.equal(cfg.nativeCategory, "omit");
  // @ts-expect-error fluxo inválido de propósito
  assert.throws(() => getFlowConfig("fluxo_inexistente"));
});

test("exportRowsToExcel grava um .xlsx real em disco e devolve o caminho", async () => {
  const dir = "./exports-test";
  rmSync(dir, { recursive: true, force: true });

  const result = await exportRowsToExcel(
    [
      { id: 1, subject: "Ação çãéíóú", status: "Novo" },
      { id: 2, subject: "Outro", status: "Fechado" },
    ],
    [
      { header: "ID", key: "id" },
      { header: "Assunto", key: "subject" },
      { header: "Status", key: "status" },
    ],
    "VIASOFT CORONEL VIVIDA 2026",
    { dir },
  );

  assert.equal(result.rowCount, 2);
  assert.ok(result.path.endsWith(".xlsx"));
  assert.match(result.path, /VIASOFT_CORONEL_VIVIDA_2026_/);

  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(result.path), "arquivo deveria existir em disco");

  rmSync(dir, { recursive: true, force: true });
});

test("exportRowsToExcel rejeita lista vazia", async () => {
  await assert.rejects(() => exportRowsToExcel([], [{ header: "ID", key: "id" }], "vazio"));
});

test("exportRowsToExcel grava volume grande (643 linhas) sem truncar — regressão do bug de exportação", async () => {
  const dir = "./exports-test-large";
  rmSync(dir, { recursive: true, force: true });

  const rows = Array.from({ length: 643 }, (_, i) => ({
    id: 890000 + i,
    subject: `Chamado de teste número ${i}`,
    status: ["Novo", "Em atendimento", "Aguardando"][i % 3],
  }));
  const columns = [
    { header: "ID", key: "id" },
    { header: "Assunto", key: "subject" },
    { header: "Status", key: "status" },
  ];

  const result = await exportRowsToExcel(rows, columns, "chamados-volume-grande", { dir });
  assert.equal(result.rowCount, 643);

  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.path);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 644); // 643 linhas de dados + 1 de cabeçalho

  rmSync(dir, { recursive: true, force: true });
});

test("loadEnv lê .env salvo com BOM (UTF-8 com marca de ordem de bytes, comum no Windows)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "movidesk-env-test-"));
  const envPath = path.join(dir, ".env");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const content = Buffer.from("TEST_BOM_VAR=funcionou\nOUTRA=valor2\n", "utf8");
  writeFileSync(envPath, Buffer.concat([bom, content]));

  const originalCwd = process.cwd();
  delete process.env.TEST_BOM_VAR;
  delete process.env.OUTRA;
  try {
    process.chdir(dir);
    loadEnv();
    assert.equal(process.env.TEST_BOM_VAR, "funcionou");
    assert.equal(process.env.OUTRA, "valor2");
  } finally {
    process.chdir(originalCwd);
    delete process.env.TEST_BOM_VAR;
    delete process.env.OUTRA;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catálogo local de serviços resolve nome -> hierarquias e id -> serviço", async () => {
  const matches = await searchKnownServices("construshow");
  assert.ok(matches.length >= 5, `esperava várias hierarquias de Construshow, achou ${matches.length}`);
  assert.ok(matches.some((s) => s.servico === "Construshow" && s.id === 131281));
  assert.ok(matches.every((s) => s.nome === "Construshow"));

  const byId = await getKnownServiceById(216138);
  assert.equal(byId?.servico, "Sistemas Internos");

  const notFound = await getKnownServiceById(999999999);
  assert.equal(notFound, null);
});

test("429 nunca faz retry automático (evita piorar o bloqueio escalonado) e expõe retryAfterSeconds", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount++;
    return new Response("", { status: 429, headers: { "Retry-After": "42" } });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => movideskHttp.get("/tickets", { select: ["id"] }),
      (err: unknown) => {
        assert.ok(err instanceof MovideskApiError);
        assert.equal(err.status, 429);
        assert.equal(err.retryAfterSeconds, 42);
        assert.match(err.message, /42 segundos/);
        return true;
      },
    );
    assert.equal(callCount, 1, "não deveria repetir a requisição em 429");
  } finally {
    global.fetch = originalFetch;
  }
});

test("5xx faz no máximo 1 retry (2 tentativas totais, não 3) e inclui o corpo na mensagem", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount++;
    return new Response(JSON.stringify({ detail: "falha interna simulada" }), { status: 500 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => movideskHttp.get("/tickets/past", { select: ["id"] }),
      (err: unknown) => {
        assert.ok(err instanceof MovideskApiError);
        assert.equal(err.status, 500);
        assert.match(err.message, /falha interna simulada/);
        return true;
      },
    );
    assert.equal(callCount, 2, "esperava 1 tentativa original + 1 retry, não 3");
  } finally {
    global.fetch = originalFetch;
  }
});

test("searchTicketsExhaustive com onlyOpen filtra baseStatus corretamente — regressão do bug 'em aberto trazia Resolvido'", async () => {
  const originalFetch = global.fetch;
  const rows = [
    { id: 1, subject: "A", status: "Novo", baseStatus: BASE_STATUS.NOVO },
    { id: 2, subject: "B", status: "Resolvido", baseStatus: BASE_STATUS.RESOLVIDO },
    { id: 3, subject: "C", status: "Em atendimento", baseStatus: BASE_STATUS.EM_ATENDIMENTO },
    { id: 4, subject: "D", status: "Cancelado", baseStatus: BASE_STATUS.CANCELADO },
    { id: 5, subject: "E", status: "Fechado", baseStatus: BASE_STATUS.FECHADO },
    { id: 6, subject: "F", status: "Aguardando", baseStatus: BASE_STATUS.PARADO },
  ];
  global.fetch = (async (url: string) => {
    const skip = Number(new URL(url).searchParams.get("$skip") ?? 0);
    return new Response(JSON.stringify(skip > 0 ? [] : rows), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await searchTicketsExhaustive(
      { filter: "1 eq 1", select: ["id", "subject", "status"] },
      { onlyOpen: true },
    );
    assert.deepEqual(
      result.tickets.map((t) => t.id),
      [1, 3, 6],
    );
    assert.equal(result.fetchedBeforeOpenFilter, 6);

    const withoutFilter = await searchTicketsExhaustive({ filter: "1 eq 1", select: ["id", "subject", "status"] });
    assert.equal(withoutFilter.tickets.length, 6, "sem onlyOpen deve devolver todos, incluindo Resolvido/Cancelado/Fechado");
  } finally {
    global.fetch = originalFetch;
  }
});

test("exportRowsToPdf grava um .pdf real, multi-página, e rejeita lista vazia", async () => {
  const dir = "./exports-test-pdf";
  rmSync(dir, { recursive: true, force: true });

  const rows = Array.from({ length: 250 }, (_, i) => ({
    id: 890000 + i,
    subject: `Chamado ção ${i}`,
    status: "Novo",
  }));
  const columns = [
    { header: "ID", key: "id" },
    { header: "Assunto", key: "subject" },
    { header: "Status", key: "status" },
  ];

  const result = await exportRowsToPdf(rows, columns, "teste-pdf", { dir, title: "Relatório de Teste" });
  assert.equal(result.rowCount, 250);
  assert.ok(result.path.endsWith(".pdf"));

  const { readFileSync, existsSync } = await import("node:fs");
  assert.ok(existsSync(result.path));
  const bytes = readFileSync(result.path);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  // Mais de uma página confirma que a paginação automática funcionou para 250 linhas.
  const pageMarkers = bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
  assert.ok(pageMarkers.length > 1, `esperava múltiplas páginas, achou ${pageMarkers.length}`);

  await assert.rejects(() => exportRowsToPdf([], columns, "vazio", { dir }));

  rmSync(dir, { recursive: true, force: true });
});

test("painel serve arquivos gerados para download e bloqueia path traversal", async () => {
  const dir = "./exports-test-download";
  rmSync(dir, { recursive: true, force: true });

  const result = await exportRowsToExcel(
    [{ id: 1, subject: "Teste", status: "Novo" }],
    [
      { header: "ID", key: "id" },
      { header: "Assunto", key: "subject" },
      { header: "Status", key: "status" },
    ],
    "teste-download",
    { dir },
  );

  const fakeSession = { async send(text: string) { return "ok: " + text; } } as any;
  const dashboard = startDashboardServer(fakeSession, 4595);

  try {
    const ws = new (await import("ws")).default("ws://localhost:4595/chat");
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const received: unknown[] = [];
    ws.on("message", (raw: Buffer) => received.push(JSON.parse(raw.toString())));

    const filename = path.basename(result.path);
    const downloadUrl = "/exports/" + encodeURIComponent(filename);
    emitEvent({
      kind: "file_ready",
      id: newEventId(),
      timestamp: new Date().toISOString(),
      filename,
      downloadUrl,
      rowCount: result.rowCount,
      format: "xlsx",
    });
    await new Promise((r) => setTimeout(r, 150));

    const fileMsg = (received as any[]).find((m) => m.type === "chat_message" && m.message.role === "file");
    assert.ok(fileMsg, "esperava um chat_message com role file");
    assert.equal(fileMsg.message.file.downloadUrl, downloadUrl);
    ws.close();

    // O servidor serve de DEFAULT_EXPORTS_DIR (padrão ./exports), não do `dir` do teste —
    // então aqui só confirmamos que a rota nega path traversal, sem depender de onde o
    // arquivo real do teste foi gravado.
    const evil = await fetch(dashboard.url + "/exports/" + encodeURIComponent("../../etc/passwd"));
    assert.equal(evil.status, 404);

    const missing = await fetch(dashboard.url + "/exports/nao-existe.xlsx");
    assert.equal(missing.status, 404);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("businessMinutesElapsed calcula horário útil conforme o SLA (seg-sex 07:45-12:00 e 13:30-18:00)", () => {
  assert.equal(BUSINESS_MINUTES_PER_DAY, 525); // 8h45min
  assert.equal(businessDaysToMinutes(3), 1575); // 3 dias úteis

  // Sexta 10:00 local -> Segunda 10:00 local: resto da sexta (2h manhã + 4h30 tarde) + 2h15 de segunda = 525min
  assert.equal(
    businessMinutesElapsed(new Date("2026-03-27T13:00:00Z"), new Date("2026-03-30T13:00:00Z")),
    525,
  );

  // Um dia útil cheio corrido (segunda 00:00 -> terça 00:00 local)
  assert.equal(
    businessMinutesElapsed(new Date("2026-03-30T03:00:00Z"), new Date("2026-03-31T03:00:00Z")),
    525,
  );

  // Durante o horário de almoço (12:30-13:00 local): não conta nada
  assert.equal(
    businessMinutesElapsed(new Date("2026-03-30T15:30:00Z"), new Date("2026-03-30T16:00:00Z")),
    0,
  );

  // to <= from: sempre 0
  assert.equal(businessMinutesElapsed(new Date("2026-03-30T13:00:00Z"), new Date("2026-03-30T13:00:00Z")), 0);
});

test("addBusinessMinutes projeta quando um prazo em horas úteis se esgota (inverso de businessMinutesElapsed)", () => {
  // Round-trip com o caso já confirmado acima: sexta 10:00 local + 525min úteis (1 dia
  // útil cheio) cai exatamente em segunda 10:00 local — mesma dupla de datas que
  // businessMinutesElapsed já confirma valer 525min.
  assert.equal(
    addBusinessMinutes(new Date("2026-03-27T13:00:00Z"), 525).toISOString(),
    new Date("2026-03-30T13:00:00Z").toISOString(),
  );

  // 0 minutos -> devolve a mesma data, sem alteração.
  const same = new Date("2026-03-30T15:00:00Z");
  assert.equal(addBusinessMinutes(same, 0).toISOString(), same.toISOString());

  // Atravessa o intervalo de almoço (12:00-13:30 local): partindo de segunda 11:45 local,
  // restam 15min de manhã; os 10min excedentes caem 10min depois do início da tarde
  // (13:40 local), nunca dentro do almoço.
  assert.equal(
    addBusinessMinutes(new Date("2026-03-30T14:45:00Z"), 25).toISOString(),
    new Date("2026-03-30T16:40:00Z").toISOString(),
  );

  // Prazo maior que 1 dia útil, começando numa sexta -> pula o fim de semana inteiro.
  assert.equal(
    addBusinessMinutes(new Date("2026-03-27T13:00:00Z"), 625).toISOString(),
    new Date("2026-03-30T14:40:00Z").toISOString(),
  );
});

test("evaluateTicket (cobrança automática): só cobra quando última ação é do owner E o prazo em horas úteis venceu", () => {
  const now = new Date("2026-04-08T15:00:00Z"); // quarta-feira, 12:00 local

  const profile = {
    scopeType: "team" as const,
    ownerTeam: "VIASOFT - Sistemas Internos",
    thresholdBusinessHours: 24, // confirmado com o usuário: 24h úteis, não dias úteis
    schedule: SLA_SCHEDULE,
  };

  const base = {
    id: 1,
    subject: "Chamado teste",
    status: "Aguardando Retorno do Cliente",
    ownerTeam: "VIASOFT - Sistemas Internos",
    owner: { id: "007-owner" },
  };

  // Owner respondeu há ~5 dias úteis (~43,75h úteis) -> vence o prazo de 24h úteis -> cobra
  const vencido = {
    ...base,
    actions: [{ createdDate: "2026-04-01T15:00:00Z", createdBy: { id: "007-owner" } }],
    statusHistories: [{ status: base.status, changedDate: "2026-04-01T15:00:00Z" }],
  };
  assert.equal(evaluateTicket(vencido, profile, now).action, "charged");

  // Cliente respondeu por último (mesmo que o prazo já tenha passado) -> nunca cobra
  const clienteRespondeu = {
    ...vencido,
    id: 2,
    actions: [
      ...vencido.actions,
      { createdDate: "2026-04-02T15:00:00Z", createdBy: { id: "cliente-123" } },
    ],
  };
  assert.equal(evaluateTicket(clienteRespondeu, profile, now).action, "skipped_owner_not_last");

  // Owner respondeu ontem (~8,75h úteis, dentro do prazo de 24h úteis) -> ainda não cobra
  const dentroDoPrazo = {
    ...base,
    id: 3,
    actions: [{ createdDate: "2026-04-07T15:00:00Z", createdBy: { id: "007-owner" } }],
    statusHistories: [{ status: base.status, changedDate: "2026-04-07T15:00:00Z" }],
  };
  assert.equal(evaluateTicket(dentroDoPrazo, profile, now).action, "skipped_within_threshold");

  // Sem owner -> não dá pra confirmar a regra -> não cobra
  const semOwner = { ...vencido, id: 4, owner: undefined };
  assert.equal(evaluateTicket(semOwner, profile, now).action, "skipped_no_data");

  // Equipe diferente de "VIASOFT - Sistemas Internos" -> nunca cobra, mesmo vencido e
  // com a última ação do owner (escopo confirmado pelo usuário: só essa equipe). As
  // horas úteis decorridas são calculadas mesmo quando o chamado é pulado por outro
  // motivo (pedido do usuário: quer ver "há quanto tempo" mesmo nos que não foram
  // cobrados) — não fica mais hardcoded em 0.
  const outraEquipe = { ...vencido, id: 5, ownerTeam: "VIASOFT - Suporte Oracle Cloud" };
  const resultadoOutraEquipe = evaluateTicket(outraEquipe, profile, now);
  assert.equal(resultadoOutraEquipe.action, "skipped_wrong_team");
  assert.ok(resultadoOutraEquipe.elapsedBusinessHours > 0, "esperava horas úteis decorridas > 0 mesmo num chamado pulado");
});

test("evaluateTicket ignora as próprias ações do remetente da automação (reminderSenderId) ao decidir quem agiu por último", () => {
  const now = new Date("2026-04-08T15:00:00Z"); // quarta-feira, 12:00 local
  const profile = {
    scopeType: "team" as const,
    ownerTeam: "VIASOFT - Sistemas Internos",
    thresholdBusinessHours: 24,
    schedule: SLA_SCHEDULE,
    reminderSenderId: "007", // cod_ref do "Alex Fable"
  };
  const base = {
    id: 1,
    subject: "Chamado já cobrado antes",
    status: "Aguardando Retorno do Cliente",
    ownerTeam: "VIASOFT - Sistemas Internos",
    owner: { id: "007-owner" },
    statusHistories: [{ status: "Aguardando Retorno do Cliente", changedDate: "2026-04-01T15:00:00Z" }],
  };

  // Owner agiu (vencido) e DEPOIS a própria automação mandou uma cobrança (reminderSenderId).
  // Sem filtrar isso, a "última ação" seria da automação, não do owner -> nunca mais cobraria.
  // Filtrando, a última ação REAL continua sendo do owner -> ainda pode ser reavaliado.
  const jaCobradoPelaAutomacao = {
    ...base,
    actions: [
      { createdDate: "2026-04-01T15:00:00Z", createdBy: { id: "007-owner" } },
      { createdDate: "2026-04-02T09:00:00Z", createdBy: { id: "007" } }, // cobrança da própria automação
    ],
  };
  const resultado = evaluateTicket(jaCobradoPelaAutomacao, profile, now);
  assert.equal(resultado.action, "charged");
  assert.ok(resultado.elapsedBusinessHours > 0);

  // Se, depois da cobrança da automação, o CLIENTE (não a automação) respondeu de
  // verdade -> aí sim conta como resposta e não cobra.
  const clienteRespondeuDepoisDaCobranca = {
    ...jaCobradoPelaAutomacao,
    id: 2,
    actions: [...jaCobradoPelaAutomacao.actions, { createdDate: "2026-04-02T10:00:00Z", createdBy: { id: "cliente-123" } }],
  };
  assert.equal(evaluateTicket(clienteRespondeuDepoisDaCobranca, profile, now).action, "skipped_owner_not_last");
});

test("evaluateTicket com escopo por owner: cobra só chamados daquele responsável específico, ignorando a equipe", () => {
  const now = new Date("2026-04-08T15:00:00Z");
  const perfilPorOwner = {
    scopeType: "owner" as const,
    ownerId: "007-owner",
    thresholdBusinessHours: 24,
    schedule: SLA_SCHEDULE,
  };
  const vencido = {
    id: 1,
    subject: "Chamado teste",
    status: "Aguardando Retorno do Cliente",
    ownerTeam: "VIASOFT - Sistemas Internos", // equipe é irrelevante nesse escopo
    owner: { id: "007-owner" },
    actions: [{ createdDate: "2026-04-01T15:00:00Z", createdBy: { id: "007-owner" } }],
    statusHistories: [{ status: "Aguardando Retorno do Cliente", changedDate: "2026-04-01T15:00:00Z" }],
  };
  assert.equal(evaluateTicket(vencido, perfilPorOwner, now).action, "charged");

  // Mesma equipe, mas owner diferente do configurado -> nunca cobra por esse perfil.
  const outroOwner = { ...vencido, id: 2, owner: { id: "outro-owner" }, actions: [{ ...vencido.actions[0], createdBy: { id: "outro-owner" } }] };
  assert.equal(evaluateTicket(outroOwner, perfilPorOwner, now).action, "skipped_wrong_owner");
});

test("evaluateTicket respeita a janela de expediente PRÓPRIA do perfil (SLAs diferentes por equipe)", () => {
  // Mesmo prazo em HORAS úteis, mas expediente maior (08:00-20:00, sem intervalo) faz o
  // dia render mais rápido em horas de relógio do que o perfil padrão (525min/dia).
  const perfilExpedienteLongo = {
    scopeType: "team" as const,
    ownerTeam: "Equipe Plantão",
    thresholdBusinessHours: 12,
    schedule: { morningStart: 8 * 60, morningEnd: 12 * 60, afternoonStart: 12 * 60, afternoonEnd: 20 * 60 },
  };
  // 12h úteis. Referência: seg 08:00 local (11:00 UTC).
  const ticket = {
    id: 10,
    subject: "Chamado plantão",
    status: "Aguardando Retorno do Cliente",
    ownerTeam: "Equipe Plantão",
    owner: { id: "007-owner" },
    actions: [{ createdDate: "2026-04-06T11:00:00Z", createdBy: { id: "007-owner" } }], // seg 08:00 local
    statusHistories: [{ status: "Aguardando Retorno do Cliente", changedDate: "2026-04-06T11:00:00Z" }],
  };
  // Antes de completar 12h úteis (mesmo dia, 19:00 local = 22:00 UTC) -> ainda não vence.
  assert.equal(
    evaluateTicket(ticket, perfilExpedienteLongo, new Date("2026-04-06T21:00:00Z")).action,
    "skipped_within_threshold",
  );
  // Depois de completar (terça 08:01 local) -> vence.
  assert.equal(evaluateTicket(ticket, perfilExpedienteLongo, new Date("2026-04-07T11:01:00Z")).action, "charged");
});

test("followUpProfiles: CRUD completo persiste em disco e valida a janela de expediente", async () => {
  const dir = "./data/followup-profiles-test";
  rmSync(dir, { recursive: true, force: true });

  // Primeira leitura semeia um perfil padrão (compatibilidade com quem já usava as
  // variáveis de ambiente antigas de uma única equipe).
  const seeded = await listFollowUpProfiles();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]?.ownerTeam, "VIASOFT - Sistemas Internos");

  const input = {
    name: "Equipe Teste",
    scopeType: "team" as const,
    ownerTeam: "VIASOFT - Equipe Teste",
    enabled: true,
    waitingStatuses: ["Aguardando Retorno do Cliente"],
    thresholdBusinessHours: 16,
    checkIntervalHours: 12,
    reminderSenderId: "999",
    reminderSenderName: "Alex Fable",
    schedule: { morningStart: 480, morningEnd: 720, afternoonStart: 780, afternoonEnd: 1080 },
  };
  const created = await createFollowUpProfile(input);
  assert.ok(created.id);
  assert.equal((await listFollowUpProfiles()).length, 2);

  const updated = await updateFollowUpProfile(created.id, { ...input, thresholdBusinessHours: 40 });
  assert.equal(updated.thresholdBusinessHours, 40);
  assert.equal(updated.id, created.id);

  await deleteFollowUpProfile(created.id);
  assert.equal((await listFollowUpProfiles()).length, 1);

  await assert.rejects(() => deleteFollowUpProfile(created.id)); // já foi apagado

  // Janela de expediente inválida (fim antes do início) é rejeitada antes de gravar.
  await assert.rejects(() =>
    createFollowUpProfile({ ...input, schedule: { ...input.schedule, morningEnd: 100 } }),
  );

  // Escopo "owner" exige ownerId (não ownerTeam); escopo "team" sem ownerTeam é rejeitado.
  await assert.rejects(() =>
    createFollowUpProfile({ ...input, scopeType: "owner", ownerId: undefined }),
  );
  const porOwner = await createFollowUpProfile({
    ...input,
    name: "Owner Teste",
    scopeType: "owner",
    ownerTeam: undefined,
    ownerId: "007-owner",
    ownerName: "Fulano de Tal",
  });
  assert.equal(porOwner.ownerId, "007-owner");
  await deleteFollowUpProfile(porOwner.id);

  rmSync(dir, { recursive: true, force: true });
});

test("painel: API /api/followup/profiles faz CRUD via HTTP (aba Automação)", async () => {
  // Reutiliza o mesmo arquivo de FOLLOWUP_PROFILES_FILE do teste anterior (fixado em
  // test/setupEnv.ts) — o valor é lido uma única vez no import do módulo, então não dá
  // pra trocar por variável de ambiente aqui em runtime.
  const dir = "./data/followup-profiles-test";
  rmSync(dir, { recursive: true, force: true });

  const fakeSession = { async send(text: string) { return "ok: " + text; } } as any;
  const dashboard = startDashboardServer(fakeSession, 4596);
  try {
    const listRes = await fetch(dashboard.url + "/api/followup/profiles");
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as any;
    assert.equal(listBody.profiles.length, 1); // perfil-semente
    assert.equal(typeof listBody.automationEnabled, "boolean");

    const createRes = await fetch(dashboard.url + "/api/followup/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Equipe HTTP",
        scopeType: "team",
        ownerTeam: "VIASOFT - Equipe HTTP",
        enabled: true,
        waitingStatuses: ["Aguardando Retorno do Cliente"],
        thresholdBusinessHours: 16,
        checkIntervalHours: 6,
        reminderSenderId: "123",
        reminderSenderName: "Alex Fable",
        schedule: { morningStart: 480, morningEnd: 720, afternoonStart: 780, afternoonEnd: 1080 },
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as any;
    assert.equal(created.ownerTeam, "VIASOFT - Equipe HTTP");

    const putRes = await fetch(dashboard.url + "/api/followup/profiles/" + created.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...created, enabled: false }),
    });
    assert.equal(putRes.status, 200);
    const updated = (await putRes.json()) as any;
    assert.equal(updated.enabled, false);

    const delRes = await fetch(dashboard.url + "/api/followup/profiles/" + created.id, { method: "DELETE" });
    assert.equal(delRes.status, 204);

    const afterDelete = (await (await fetch(dashboard.url + "/api/followup/profiles")).json()) as any;
    assert.equal(afterDelete.profiles.length, 1);

    // Rodar manualmente um perfil quando o gate global está desligado -> 409, não busca nada.
    const runRes = await fetch(dashboard.url + "/api/followup/profiles/" + afterDelete.profiles[0].id + "/run", {
      method: "POST",
    });
    assert.equal(runRes.status, 409);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFollowUpCheck: quando não encontra nenhum chamado, roda diagnóstico e aponta a causa provável (equipe/status não bate)", async () => {
  // runFollowUpCheck sempre chama markFollowUpProfileRan ao final, que lê/escreve
  // FOLLOWUP_PROFILES_FILE (mesmo arquivo compartilhado com os testes de CRUD acima) —
  // limpa antes/depois para não deixar um perfil-semente residual no disco.
  const dir = "./data/followup-profiles-test";
  rmSync(dir, { recursive: true, force: true });
  const originalFetch = global.fetch;
  global.fetch = (async (url: string) => {
    const filter = new URL(url).searchParams.get("$filter") ?? "";
    const skip = Number(new URL(url).searchParams.get("$skip") ?? 0);
    if (filter.includes("ownerTeam eq")) {
      // busca principal (com filtro de equipe) -> nada encontrado
      return new Response(JSON.stringify([]), { status: 200 });
    }
    // busca de diagnóstico (só por status, sem equipe) -> existem chamados, mas de outras equipes
    const sample = [
      { id: 901, ownerTeam: "VIASOFT - Outra Equipe" },
      { id: 902, ownerTeam: "VIASOFT - Mais Uma" },
    ];
    return new Response(JSON.stringify(skip > 0 ? [] : sample), { status: 200 });
  }) as typeof fetch;

  const profile: FollowUpProfile = {
    id: "perfil-teste",
    name: "Sistemas Internos",
    scopeType: "team",
    ownerTeam: "VIASOFT - Sistemas Internos",
    enabled: true,
    waitingStatuses: ["Aguardando Retorno do Cliente", "Aguardando Validação do Cliente"],
    thresholdBusinessHours: 24,
    checkIntervalHours: 24,
    reminderSenderId: "007",
    reminderSenderName: "Alex Fable",
    schedule: SLA_SCHEDULE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    const result = await runFollowUpCheck(profile);
    assert.equal(result.checkedCount, 0);
    assert.ok(result.diagnostics?.length, "esperava diagnostics preenchido quando checkedCount é 0");
    const diag = result.diagnostics!.join(" ");
    assert.match(diag, /Sem o filtro de equipe, existem \d+ chamado\(s\)/);
    assert.match(diag, /VIASOFT - Outra Equipe/);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateTicket com waitingJustifications: distingue por 'justification' quando 'status' é genérico (bug real de produção)", () => {
  // Regressão de um bug real: um tenant usa status genérico ("Aguardando", baseStatus
  // "Stopped") para QUALQUER pausa, e o motivo específico (retorno vs validação do
  // cliente) fica em `justification`. Filtrar só por status (ex: "Aguardando Retorno do
  // Cliente" como se fosse o texto literal do status) nunca encontra nada nesse tenant.
  const now = new Date("2026-09-04T15:00:00Z"); // sexta-feira, 12:00 local — dias úteis depois de 28/08

  const perfilComJustification = {
    scopeType: "team" as const,
    ownerTeam: "VIASOFT - Sistemas Internos",
    waitingJustifications: ["Validação Cliente"],
    thresholdBusinessHours: 24,
    schedule: SLA_SCHEDULE,
  };

  const ticket = {
    id: 894793,
    subject: "[Movidesk] usuário quer permissão para ser administrador",
    status: "Aguardando",
    justification: "Validação Cliente",
    ownerTeam: "VIASOFT - Sistemas Internos",
    owner: { id: "1562521409" },
    actions: [
      { createdDate: "2026-08-28T11:33:44.5745442Z", createdBy: { id: "e4eaea2a-a1d2-4848-" } },
      { createdDate: "2026-08-31T12:20:04.8637998Z", createdBy: { id: "1562521409" } }, // última ação é do owner
    ],
    statusHistories: [
      { status: "Novo", justification: null, changedDate: "2026-08-28T11:33:44.2738089Z" },
      { status: "Aguardando", justification: "Validação Cliente", changedDate: "2026-08-28T11:36:34.0306053Z" },
      { status: "Em atendimento", justification: "Respondido pelo cliente", changedDate: "2026-08-28T11:38:18.5009192Z" },
      { status: "Aguardando", justification: "Validação Cliente", changedDate: "2026-08-28T13:03:27.2566814Z" },
    ],
  };

  // Vencido (mais de 24h úteis desde a última ação do owner, 31/08) e justification bate -> cobra.
  assert.equal(evaluateTicket(ticket, perfilComJustification, now).action, "charged");

  // Mesmo chamado, mas o perfil só monitora outra justificativa -> nunca cobra por esse perfil.
  const outroPerfil = { ...perfilComJustification, waitingJustifications: ["Retorno Cliente"] };
  assert.equal(evaluateTicket(ticket, outroPerfil, now).action, "skipped_wrong_justification");

  // Sem waitingJustifications configurado (comportamento antigo) -> ignora o campo, só olha status.
  const perfilSemJustification = { ...perfilComJustification, waitingJustifications: undefined };
  assert.equal(evaluateTicket(ticket, perfilSemJustification, now).action, "charged");
});

test("decideAutoClose: só fecha quando ninguém respondeu à cobrança E o mesmo prazo (agora contado da cobrança) venceu", () => {
  const now = new Date("2026-09-04T15:00:00Z"); // sexta-feira, 12:00 local
  const record = {
    chargedAt: "2026-09-01T15:00:00Z", // terça 12:00 local — ~3 dias úteis antes de `now`
    thresholdBusinessHours: 24,
    schedule: SLA_SCHEDULE,
    reminderSenderId: "007",
    ownerId: "007-owner",
  };
  const profileOn = { autoCloseEnabled: true };

  // Gate do PERFIL desligado -> nunca fecha, mesmo com tudo mais vencido.
  assert.equal(decideAutoClose({ baseStatus: "Stopped", actions: [] }, record, { autoCloseEnabled: false }, now), "disabled");

  // Alguém mudou o status manualmente (não está mais "Stopped") -> resolvido por fora, nunca fecha.
  assert.equal(decideAutoClose({ baseStatus: "Resolved", actions: [] }, record, profileOn, now), "resolved_externally");

  // Última ação é do CLIENTE (nem reminderSenderId nem ownerId) -> cliente respondeu, nunca fecha.
  const respondeu = { baseStatus: "Stopped", actions: [{ createdDate: "2026-09-02T10:00:00Z", createdBy: { id: "cliente-123" } }] };
  assert.equal(decideAutoClose(respondeu, record, profileOn, now), "responded");

  // Última ação ainda é da automação (reminderSenderId), mas ainda dentro das 24h úteis
  // desde a cobrança -> ainda não fecha.
  const cobradoOntem = {
    baseStatus: "Stopped",
    actions: [{ createdDate: "2026-09-03T15:00:00Z", createdBy: { id: "007" } }], // quinta 12:00 local
  };
  assert.equal(decideAutoClose(cobradoOntem, { ...record, chargedAt: "2026-09-03T15:00:00Z" }, profileOn, now), "within_threshold");

  // Última ação é do OWNER (respondeu de novo, mas o cliente continua em silêncio) e já
  // passou das 24h úteis desde a cobrança original -> fecha.
  const semRespostaDoCliente = {
    baseStatus: "Stopped",
    actions: [{ createdDate: "2026-09-02T10:00:00Z", createdBy: { id: "007-owner" } }],
  };
  assert.equal(decideAutoClose(semRespostaDoCliente, record, profileOn, now), "should_close");
});
