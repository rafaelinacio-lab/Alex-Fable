/**
 * Diagnóstico de configuração — roda com `npm run check-env`.
 *
 * Mostra, sem nunca imprimir o valor real de nenhuma credencial, se cada variável
 * importante foi encontrada, de onde veio (arquivo .env encontrado ou não) e um
 * comprimento/prefixo mascarado — o suficiente para diagnosticar "não configurei",
 * "configurei vazio", "tem espaço/aspas sobrando" etc. sem vazar segredo nenhum.
 */

import "./loadEnv.js"; // side effect: carrega o .env, se existir
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function findEnvFileForDiagnosis(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function mask(value: string | undefined): string {
  if (value === undefined) return "(não definida)";
  if (value === "") return "(definida, mas VAZIA — provavelmente falta preencher no .env)";
  const trimmed = value.trim();
  const hasSurroundingSpace = trimmed !== value;
  const prefix = value.slice(0, Math.min(6, value.length));
  const suffix = value.length > 10 ? value.slice(-2) : "";
  return (
    `definida, ${value.length} caractere(s), começa com "${prefix}..."${suffix ? ` termina com "...${suffix}"` : ""}` +
    (hasSurroundingSpace ? " ⚠ tem espaço em branco sobrando no início/fim" : "")
  );
}

function main(): void {
  console.log("=== Diagnóstico de configuração do agente Movidesk ===\n");

  console.log("Diretório atual (cwd):", process.cwd());

  const envFile = findEnvFileForDiagnosis();
  if (!envFile) {
    console.log("\n❌ Nenhum arquivo .env encontrado subindo a partir do diretório atual.");
    console.log("   Copie .env.example para .env na raiz do projeto (mesma pasta do package.json).");
  } else {
    console.log(".env encontrado em:", envFile);
    const raw = readFileSync(envFile);
    const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    console.log("Tamanho do arquivo:", raw.length, "bytes");
    console.log("Começa com BOM UTF-8:", hasBom ? "sim (o loader já trata isso)" : "não");
    const lineCount = raw.toString("utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    console.log("Linhas não vazias/comentário no .env:", lineCount);
  }

  console.log("\n--- Variáveis ---");
  console.log("OPENAI_API_KEY:", mask(process.env.OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", process.env.OPENAI_MODEL ?? "(usando padrão: gpt-4.1)");
  console.log("MOVIDESK_TOKEN:", mask(process.env.MOVIDESK_TOKEN));
  console.log("MOVIDESK_BASE_URL:", process.env.MOVIDESK_BASE_URL ?? "(usando padrão)");

  console.log("\n=== Fim do diagnóstico ===");
  if (!process.env.OPENAI_API_KEY) {
    console.log(
      "\n👉 OPENAI_API_KEY não está chegando ao processo. Confirme que o .env está na" +
        " MESMA pasta de onde você roda `npm run dev` (normalmente a raiz do projeto)," +
        " e que a linha está exatamente como `OPENAI_API_KEY=sk-...` (sem aspas, sem" +
        " espaço antes/depois do =).",
    );
  }
}

main();
