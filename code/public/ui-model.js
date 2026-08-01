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
