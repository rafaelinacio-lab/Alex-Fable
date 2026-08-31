/**
 * Cálculo de tempo em horário útil (expediente), conforme o SLA de atendimento deste
 * tenant (documento interno "SLA de Atendimento — Movidesk", seção 2):
 *
 *   Horário de atendimento: Seg–Sex, 07:45–12:00 e 13:30–18:00.
 *   "Tickets abertos fora deste horário entram na fila e têm o SLA iniciado no próximo
 *   período útil."
 *
 * Isso dá 8h45min (525 minutos) de expediente por dia útil. Usado para decidir se um
 * chamado "aguardando retorno/validação do cliente" já passou do prazo de silêncio
 * configurado (ver src/config/followUp.ts) — contando em HORAS ÚTEIS, não em dias
 * corridos, como pedido explicitamente.
 *
 * Premissas assumidas (documentar/ajustar se não bater com a realidade):
 *  - Datas da API do Movidesk vêm em UTC (confirmado na doc da API); o expediente é
 *    definido em horário local do Brasil. Assume-se America/Sao_Paulo = UTC-3 fixo
 *    (o Brasil aboliu horário de verão em 2019) — ver `TIMEZONE_OFFSET_MINUTES`.
 *  - Sem calendário de feriados por padrão (só exclui sábado/domingo). Se precisar
 *    excluir feriados também, passe `holidays` (strings "YYYY-MM-DD" em horário local).
 */

export interface BusinessSchedule {
  /** Minutos desde a meia-noite local. Ex: 07:45 = 465. */
  morningStart: number;
  morningEnd: number;
  afternoonStart: number;
  afternoonEnd: number;
}

/** Seg–Sex, 07:45–12:00 e 13:30–18:00 — confirmado no SLA deste tenant. */
export const SLA_SCHEDULE: BusinessSchedule = {
  morningStart: 7 * 60 + 45, // 465
  morningEnd: 12 * 60, // 720
  afternoonStart: 13 * 60 + 30, // 810
  afternoonEnd: 18 * 60, // 1080
};

/** Minutos úteis num dia cheio de expediente, dada uma janela. */
export function minutesPerBusinessDay(schedule: BusinessSchedule): number {
  return schedule.morningEnd - schedule.morningStart + (schedule.afternoonEnd - schedule.afternoonStart);
}

/** Minutos úteis num dia cheio de expediente PADRÃO deste tenant: (720-465) + (1080-810) = 525min = 8h45min. */
export const BUSINESS_MINUTES_PER_DAY = minutesPerBusinessDay(SLA_SCHEDULE);

/** America/Sao_Paulo, UTC-3 fixo (sem horário de verão desde 2019). Ajuste se o tenant for outro fuso. */
export const TIMEZONE_OFFSET_MINUTES = -3 * 60;

function toLocal(date: Date): Date {
  return new Date(date.getTime() + TIMEZONE_OFFSET_MINUTES * 60_000);
}

function minutesSinceMidnight(localDate: Date): number {
  return localDate.getUTCHours() * 60 + localDate.getUTCMinutes() + localDate.getUTCSeconds() / 60;
}

function isWeekend(localDate: Date): boolean {
  const day = localDate.getUTCDay(); // 0 = domingo, 6 = sábado
  return day === 0 || day === 6;
}

function dateKey(localDate: Date): string {
  return localDate.toISOString().slice(0, 10);
}

/**
 * Minutos úteis (dentro do expediente configurado) num único dia, entre `from` e `to`
 * (ambos já em horário local, mesmo dia). `to` pode ser o fim do dia ou um horário
 * intermediário (para o primeiro/último dia do intervalo).
 */
function businessMinutesInDay(localFrom: Date, localTo: Date, schedule: BusinessSchedule): number {
  if (isWeekend(localFrom)) return 0;
  const fromMin = minutesSinceMidnight(localFrom);
  const toMin = minutesSinceMidnight(localTo);
  let total = 0;
  total += overlap(fromMin, toMin, schedule.morningStart, schedule.morningEnd);
  total += overlap(fromMin, toMin, schedule.afternoonStart, schedule.afternoonEnd);
  return total;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

/**
 * Minutos úteis (expediente, seg-sex, excluindo feriados informados) entre duas datas
 * UTC quaisquer. Se `to <= from`, devolve 0.
 */
export function businessMinutesElapsed(
  from: Date,
  to: Date,
  opts?: { schedule?: BusinessSchedule; holidays?: Set<string> },
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const schedule = opts?.schedule ?? SLA_SCHEDULE;
  const holidays = opts?.holidays ?? new Set<string>();

  const localFrom = toLocal(from);
  const localTo = toLocal(to);

  let minutes = 0;
  const cursor = new Date(localFrom);

  while (cursor.getTime() < localTo.getTime()) {
    const endOfDay = new Date(cursor);
    endOfDay.setUTCHours(23, 59, 59, 999); // "UTC" aqui porque já convertemos para local acima
    const segmentEnd = endOfDay.getTime() < localTo.getTime() ? endOfDay : localTo;

    if (!holidays.has(dateKey(cursor))) {
      minutes += businessMinutesInDay(cursor, segmentEnd, schedule);
    }

    // avança para 00:00 do próximo dia local
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  return minutes;
}

/**
 * Quantos minutos úteis correspondem a N "dias úteis" cheios, dada uma janela de
 * expediente (padrão: a deste tenant, SLA_SCHEDULE). Perfis com expediente diferente
 * (ver src/config/followUpProfiles.ts) devem passar seu próprio `schedule` aqui — "3
 * dias úteis" significa coisas diferentes para equipes com janelas diferentes.
 */
export function businessDaysToMinutes(days: number, schedule: BusinessSchedule = SLA_SCHEDULE): number {
  return days * minutesPerBusinessDay(schedule);
}
