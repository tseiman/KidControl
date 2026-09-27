export function canStart(role, power, active) {
  return !active && (role === 'superuser' || power === 'on');
}

export function initials(displayName) {
  const letters = String(displayName ?? '')
    .trim()
    .split(/\s+/u)
    .map((part) => Array.from(part).find((character) => /[\p{L}\p{N}]/u.test(character)))
    .filter(Boolean);
  if (letters.length === 0) return '?';
  const selected = letters.length === 1 ? letters : [letters[0], letters.at(-1)];
  return selected.join('').toLocaleUpperCase().slice(0, 2);
}

export function parseRetryAfter(value) {
  if (!/^\d+$/.test(String(value ?? ''))) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function formatLoginLockDuration(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
