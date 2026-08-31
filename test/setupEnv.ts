/**
 * Import isto ANTES de qualquer módulo que leia process.env no momento do import
 * (ex: src/movidesk/client.ts captura MOVIDESK_TOKEN em uma constante top-level).
 * Precisa ser o primeiro import do arquivo de teste para valer antes da avaliação
 * dos módulos seguintes.
 */
process.env.MOVIDESK_TOKEN ??= "test-token-nao-real";
// Isola o arquivo de perfis da automação de cobrança do arquivo real usado em dev/produção.
process.env.FOLLOWUP_PROFILES_FILE ??= "./data/followup-profiles-test/perfis.json";
