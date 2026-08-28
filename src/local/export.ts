/**
 * Exportação de resultados para arquivo .xlsx real, gravado em disco.
 *
 * Isto existe porque, sem isso, o agente não tinha nenhuma forma real de "entregar um
 * Excel" — só podia colar CSV como texto no chat, o que é ruim para volumes grandes e
 * não é o que o usuário pede quando fala "excel"/"planilha". Como o agente roda como
 * processo local (CLI) na máquina do próprio usuário, gravar o arquivo em disco e
 * devolver o caminho é a entrega real: o usuário abre direto no Excel.
 */

import ExcelJS from "exceljs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EXPORTS_DIR } from "./exportsDir.js";

const MAX_ROWS = 50_000; // proteção contra geração descontrolada de arquivos gigantes

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
}

export interface ExportResult {
  path: string;
  rowCount: number;
}

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function sanitizeFilename(hint: string): string {
  const base = hint
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "") // remove acentos após normalização NFD
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  return base || "export";
}

/**
 * Grava `rows` em um arquivo .xlsx real dentro de `EXPORTS_DIR` e devolve o caminho
 * absoluto. `filenameHint` vira a base do nome do arquivo (um timestamp é sempre
 * anexado, então múltiplas exportações nunca se sobrescrevem).
 */
export async function exportRowsToExcel(
  rows: Array<Record<string, unknown>>,
  columns: ExportColumn[],
  filenameHint: string,
  opts?: { sheetName?: string; dir?: string },
): Promise<ExportResult> {
  if (rows.length === 0) {
    throw new Error("Nada para exportar: a lista de linhas está vazia.");
  }
  if (rows.length > MAX_ROWS) {
    throw new Error(`Exportação excede o limite de ${MAX_ROWS} linhas (tem ${rows.length}). Refine a busca.`);
  }

  const dir = opts?.dir ?? DEFAULT_EXPORTS_DIR;
  await mkdir(dir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts?.sheetName ?? "Chamados");
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 22 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${sanitizeFilename(filenameHint)}_${timestamp}.xlsx`;
  const filePath = path.resolve(dir, filename);

  await workbook.xlsx.writeFile(filePath);

  return { path: filePath, rowCount: rows.length };
}
