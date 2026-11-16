const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function localParts(date: Date): { day: string; minute: number } {
  const parts = formatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: `${value('year')}-${value('month')}-${value('day')}`,
    minute: Number(value('hour')) * 60 + Number(value('minute'))
  };
}

function nextCalendarDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

export function validResetTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value);
}

export function resetOccurrence(day: string, time: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validResetTime(time)) throw new Error('daily reset time must be HH:MM');
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const approximate = Date.UTC(year, month - 1, date, Math.floor(target / 60), target % 60);
  const start = approximate - 3 * 60 * 60 * 1000;
  const end = approximate + 3 * 60 * 60 * 1000;
  for (let instant = start; instant <= end; instant += 60_000) {
    const local = localParts(new Date(instant));
    if (local.day === day && local.minute >= target) return new Date(instant);
  }
  throw new Error(`cannot resolve Europe/Berlin reset occurrence for ${day} ${time}`);
}

export function nextDailyReset(after: Date, time: string): Date {
  if (!validResetTime(time)) throw new Error('daily reset time must be HH:MM');
  let day = localParts(after).day;
  let occurrence = resetOccurrence(day, time);
  if (occurrence.getTime() <= after.getTime()) {
    day = nextCalendarDay(day);
    occurrence = resetOccurrence(day, time);
  }
  return occurrence;
}
