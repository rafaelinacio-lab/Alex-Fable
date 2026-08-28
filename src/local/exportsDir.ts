/**
 * Diretório de exportações (Excel/PDF), compartilhado entre os geradores de arquivo
 * (export.ts, pdfExport.ts) e o servidor do painel (que serve esses arquivos para
 * download via HTTP em /exports/:filename — ver src/server/dashboard.ts).
 */
export const DEFAULT_EXPORTS_DIR = process.env.EXPORTS_DIR ?? "./exports";
