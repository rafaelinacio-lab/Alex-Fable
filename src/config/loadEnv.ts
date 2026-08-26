/**
 * Carrega o arquivo `.env` da raiz do projeto para `process.env`, sem depender de
 * pacotes externos nem de flags específicas do Node (`--env-file` não existe em todas
 * as versões/plataformas que os usuários deste projeto rodam — ex: Windows + npm scripts
 * não repassam flags do jeito esperado). Import este módulo primeiro, antes de qualquer
 * outro módulo que leia `process.env` (ex: `orchestrator.ts`, `movidesk/client.ts`).
 *
 * Formato suportado: `CHAVE=valor` por linha, linhas em branco e iniciadas com `#`
 * ignoradas, aspas simples/duplas ao redor do valor são removidas. Nunca sobrescreve uma
 * variável já definida no ambiente (env real tem prioridade sobre o `.env`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

function findEnvFile(): string | null {
  // Procura .env a partir do diretório atual, subindo até achar (ou até a raiz).
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadEnv(): void {
  const file = findEnvFile();
  if (!file) return;
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();
