/**
 * Calcula cuántos segundos faltan para la medianoche
 * en la zona horaria de negocio indicada.
 *
 * Se usa para firmar el JWT del vendedor: la sesión
 * dura solo lo que reste del día calendario local.
 */
export function secondsUntilEndOfDay(
  timeZone: string,
  now: Date = new Date(),
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const minute = get('minute');
  const second = get('second');

  const secondsElapsedToday = hour * 3600 + minute * 60 + second;
  const secondsInDay = 24 * 3600;
  const remaining = secondsInDay - secondsElapsedToday;

  // Evita tokens con expiresIn = 0 si cae exactamente en medianoche.
  return Math.max(remaining, 60);
}

/**
 * Devuelve la fecha/hora ISO UTC del fin del día en la zona indicada.
 * Útil para exponer `expiresAt` al frontend.
 */
export function endOfDayUtcIso(
  timeZone: string,
  now: Date = new Date(),
): string {
  const remainingSeconds = secondsUntilEndOfDay(timeZone, now);
  return new Date(now.getTime() + remainingSeconds * 1000).toISOString();
}

type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function calendarParts(timeZone: string, date: Date): CalendarParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function timeZoneOffsetMs(timeZone: string, instant: Date): number {
  const parts = calendarParts(timeZone, instant);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

function zonedMidnightUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const first = new Date(guess.getTime() - timeZoneOffsetMs(timeZone, guess));
  return new Date(first.getTime() - timeZoneOffsetMs(timeZone, first));
}

/**
 * Fin del día calendario siguiente en la zona de negocio.
 * El instante es las 00:00 del día subsiguiente (exclusivo):
 * una contraseña creada hoy sigue vigente todo el día de mañana.
 */
export function endOfNextCalendarDay(
  timeZone: string,
  now: Date = new Date(),
): Date {
  const today = calendarParts(timeZone, now);
  const afterNext = addCalendarDays(today.year, today.month, today.day, 2);
  return zonedMidnightUtc(
    timeZone,
    afterNext.year,
    afterNext.month,
    afterNext.day,
  );
}

/** Fecha YYYY-MM-DD del instante en la zona indicada. */
export function calendarDateInZone(timeZone: string, date: Date): string {
  const parts = calendarParts(timeZone, date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}
