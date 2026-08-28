/**
 * Exportação de resultados para arquivo .pdf real, gravado em disco.
 *
 * Mesmo padrão de src/local/export.ts (Excel): a tabela é montada e escrita
 * inteiramente aqui, no servidor — nunca peça ao modelo para "montar" um PDF
 * repassando cada linha como texto/JSON numa chamada de ferramenta. Isso já causou um
 * bug real com a exportação para Excel (truncava silenciosamente em volumes grandes
 * porque o modelo tinha que retransmitir cada linha); a mesma armadilha vale aqui.
 */

import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_EXPORTS_DIR = process.env.EXPORTS_DIR ?? "./exports";
// PDF é para relatórios legíveis, não para descarregar bases inteiras — bem menor que o limite do Excel.
export const PDF_MAX_ROWS = 5_000;

export interface PdfColumn {
  header: string;
  key: string;
  /** Largura relativa da coluna (proporção entre colunas); se omitido, todas ficam iguais. */
  width?: number;
}

export interface PdfExportResult {
  path: string;
  rowCount: number;
}

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function sanitizeFilename(hint: string): string {
  const base = hint
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  return base || "export";
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Grava `rows` em um arquivo .pdf real dentro de `EXPORTS_DIR` (uma tabela simples,
 * paginada automaticamente) e devolve o caminho absoluto.
 */
export async function exportRowsToPdf(
  rows: Array<Record<string, unknown>>,
  columns: PdfColumn[],
  filenameHint: string,
  opts?: { title?: string; dir?: string },
): Promise<PdfExportResult> {
  if (rows.length === 0) {
    throw new Error("Nada para exportar: a lista de linhas está vazia.");
  }
  if (rows.length > PDF_MAX_ROWS) {
    throw new Error(
      `Exportação para PDF excede o limite de ${PDF_MAX_ROWS} linhas (tem ${rows.length}). Para volumes maiores, use a exportação em Excel.`,
    );
  }

  const dir = opts?.dir ?? DEFAULT_EXPORTS_DIR;
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${sanitizeFilename(filenameHint)}_${timestamp}.pdf`;
  const filePath = path.resolve(dir, filename);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalWeight = columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
  const colWidths = columns.map((c) => (pageWidth * (c.width ?? 1)) / totalWeight);
  const rowHeight = 18;
  const headerFontSize = 9;
  const cellFontSize = 8;

  doc.fontSize(14).text(opts?.title ?? "Relatório de chamados", { align: "left" });
  doc
    .fontSize(9)
    .fillColor("#666666")
    .text(`Gerado em ${new Date().toLocaleString("pt-BR")} — ${rows.length} registro(s)`, { align: "left" });
  doc.fillColor("#000000");
  doc.moveDown(0.5);

  function drawHeader(): void {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(headerFontSize);
    let x = doc.page.margins.left;
    columns.forEach((col, i) => {
      doc.text(col.header, x + 2, y + 4, { width: colWidths[i]! - 4, ellipsis: true });
      x += colWidths[i]!;
    });
    doc
      .moveTo(doc.page.margins.left, y + rowHeight)
      .lineTo(doc.page.width - doc.page.margins.right, y + rowHeight)
      .strokeColor("#cccccc")
      .stroke();
    doc.y = y + rowHeight;
    doc.font("Helvetica").fontSize(cellFontSize);
  }

  function ensureSpace(): void {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }
  }

  drawHeader();
  for (const row of rows) {
    ensureSpace();
    const y = doc.y;
    let x = doc.page.margins.left;
    columns.forEach((col, i) => {
      doc.text(cellText(row[col.key]), x + 2, y + 3, { width: colWidths[i]! - 4, height: rowHeight, ellipsis: true });
      x += colWidths[i]!;
    });
    doc.y = y + rowHeight;
  }

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });

  return { path: filePath, rowCount: rows.length };
}
