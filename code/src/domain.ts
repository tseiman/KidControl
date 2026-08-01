export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = typeof WEEKDAYS[number];
export type Role = 'user' | 'superuser';
export interface UserConfig { id: string; displayName: string; icon?: string; pin: string; role: Role; weeklyBudgetMinutes?: Record<Weekday, number> }
export interface DeviceConfig { id: string; displayName: string; aclRuleName: string; appleTvIdentifier: string }
export interface Config { timezone: string; users: UserConfig[]; devices: DeviceConfig[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

export function validateConfig(value: unknown): Config {
  const root = object(value);
  if (root.timezone !== 'Europe/Berlin') throw new Error('timezone must be Europe/Berlin');
  if (!Array.isArray(root.users) || root.users.length === 0) throw new Error('users must not be empty');
  if (!Array.isArray(root.devices) || root.devices.length === 0) throw new Error('devices must not be empty');
  const users: UserConfig[] = root.users.map((raw) => {
    const item = object(raw); const role = item.role;
    if (role !== 'user' && role !== 'superuser') throw new Error('role must be user or superuser');
    const pin = text(item.pin, 'pin');
    if (!/^\d{4}$/.test(pin)) throw new Error('pin must contain exactly four digits');
    const icon = item.icon === undefined ? undefined : text(item.icon, 'user icon');
    if (icon && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)$/i.test(icon)) {
      throw new Error('user icon must be a PNG, JPEG, or WebP filename without a path');
    }
    let weeklyBudgetMinutes: Record<Weekday, number> | undefined;
    if (role === 'user') {
      const source = object(item.weeklyBudgetMinutes);
      weeklyBudgetMinutes = {} as Record<Weekday, number>;
      for (const day of WEEKDAYS) {
        const minutes = source[day];
        if (!Number.isInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 1499) throw new Error(`${day} budget must be 0..1499 minutes`);
        weeklyBudgetMinutes[day] = minutes as number;
      }
    }
    return { id: text(item.id, 'user id'), displayName: text(item.displayName, 'displayName'), ...(icon ? { icon } : {}), pin, role, ...(weeklyBudgetMinutes ? { weeklyBudgetMinutes } : {}) };
  });
  const devices: DeviceConfig[] = root.devices.map((raw) => {
    const item = object(raw);
    return { id: text(item.id, 'device id'), displayName: text(item.displayName, 'displayName'), aclRuleName: text(item.aclRuleName, 'aclRuleName'), appleTvIdentifier: text(item.appleTvIdentifier, 'appleTvIdentifier') };
  });
  const ids = [...users.map((u) => u.id), ...devices.map((d) => d.id)];
  if (new Set(ids).size !== ids.length) throw new Error('user and device ids must be unique');
  if (new Set(devices.map((d) => d.aclRuleName)).size !== devices.length) throw new Error('aclRuleName values must be unique');
  return { timezone: 'Europe/Berlin', users, devices };
}

export function berlinDay(date: Date, timezone = 'Europe/Berlin'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function weekday(date: Date, timezone = 'Europe/Berlin'): Weekday {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date).toLowerCase() as Weekday;
}
export function budgetFor(user: UserConfig, date: Date, timezone = 'Europe/Berlin'): number {
  return user.role === 'superuser' ? Number.MAX_SAFE_INTEGER : (user.weeklyBudgetMinutes?.[weekday(date, timezone)] ?? 0) * 60;
}
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return [Math.floor(safe / 3600), Math.floor(safe % 3600 / 60), safe % 60].map((n) => String(n).padStart(2, '0')).join(':');
}
