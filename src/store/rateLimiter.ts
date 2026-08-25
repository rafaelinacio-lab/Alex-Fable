/**
 * Rate limiter simples de janela deslizante (seção 5 do prompt de sistema):
 * "Respeite o limite padrão de 10 requisições por minuto."
 *
 * Em processo único isso é suficiente; com múltiplas réplicas do orquestrador, troque por
 * um limiter compartilhado (Redis) — o contrato (`acquire`) permanece o mesmo.
 */

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(limitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 10), windowMs = 60_000) {
    this.limit = limitPerMinute;
    this.windowMs = windowMs;
  }

  /** Resolve quando é seguro fazer a próxima requisição, aguardando se necessário. */
  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length < this.limit) {
      this.timestamps.push(now);
      return;
    }
    const oldest = this.timestamps[0]!;
    const waitMs = this.windowMs - (now - oldest) + 25; // pequena folga
    await sleep(waitMs);
    return this.acquire();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffWithJitter(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
