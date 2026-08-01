import { describe, expect, it } from 'vitest';
import { canStart, initials } from '../public/ui-model.js';

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
});
