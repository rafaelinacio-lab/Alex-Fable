import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { odataEscape, buildQueryString } from "../src/movidesk/client.js";
import { escapeHtml, validateSubject } from "../src/movidesk/tickets.js";
import { buildIdempotencyKey, idempotencyReserve, idempotencyPut, idempotencyGet } from "../src/store/idempotency.js";
import { RateLimiter } from "../src/store/rateLimiter.js";
import { getFlowConfig } from "../src/config/tenant.js";
import { exportRowsToExcel } from "../src/local/export.js";
import { loadEnv } from "../src/config/loadEnv.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
