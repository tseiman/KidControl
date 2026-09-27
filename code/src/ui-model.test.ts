import { describe, expect, it } from 'vitest';
import { canStart, formatLoginLockDuration, initials, parseRetryAfter } from '../public/ui-model.js';

describe('WebUI presentation policy', () => {
  it('enables regular starts only for confirmed-on devices and leaves superusers unrestricted', () => {
    expect(canStart('user', 'on', false)).toBe(true);
    expect(canStart('user', 'off', false)).toBe(false);
    expect(canStart('user', 'unknown', false)).toBe(false);
    expect(canStart('superuser', 'off', false)).toBe(true);
    expect(canStart('superuser', 'unknown', false)).toBe(true);
    expect(canStart('superuser', 'on', true)).toBe(false);
  });

  it('creates short safe initials from a display name', () => {
    expect(initials('Anna Beispiel')).toBe('AB');
    expect(initials('  wohnzimmer  ')).toBe('W');
    expect(initials('<script> Test')).toBe('ST');
    expect(initials('')).toBe('?');
  });

  it('parses Retry-After and formats the remaining login lock as a countdown', () => {
    expect(parseRetryAfter('900')).toBe(900);
    expect(parseRetryAfter('61')).toBe(61);
    expect(parseRetryAfter('0')).toBeUndefined();
    expect(parseRetryAfter('invalid')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(formatLoginLockDuration(900)).toBe('15:00');
    expect(formatLoginLockDuration(61)).toBe('01:01');
    expect(formatLoginLockDuration(0)).toBe('00:00');
  });
});
