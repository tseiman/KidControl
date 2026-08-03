export type OperationalLogValue = string | number | boolean | null | undefined;

const EVENT_NAME = /^[a-z][a-z0-9-]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export function formatOperationalEvent(event: string, fields: Record<string, OperationalLogValue>): string {
  if (!EVENT_NAME.test(event)) throw new Error('invalid event name');
  const parts = [`event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(key)) throw new Error('invalid field name');
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid numeric log value');
    const encoded = typeof value === 'string'
      ? JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      : String(value);
    parts.push(`${key}=${encoded}`);
  }
  return parts.join(' ');
}

export function logOperationalInfo(event: string, fields: Record<string, OperationalLogValue>): void {
  console.info(formatOperationalEvent(event, fields));
}

export function logOperationalError(event: string, fields: Record<string, OperationalLogValue>): void {
  console.error(formatOperationalEvent(event, fields));
}
