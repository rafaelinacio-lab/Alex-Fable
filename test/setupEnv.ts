/**
 * Import isto ANTES de qualquer módulo que leia process.env no momento do import
 * (ex: src/movidesk/client.ts captura MOVIDESK_TOKEN em uma constante top-level).
 * Precisa ser o primeiro import do arquivo de teste para valer antes da avaliação
 * dos módulos seguintes.
 */
process.env.MOVIDESK_TOKEN ??= "test-token-nao-real";
