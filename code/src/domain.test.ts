import { describe, expect, it } from 'vitest';
import { berlinDay, budgetFor, formatDuration, validateConfig } from './domain.js';

const budgets = { monday: 60, tuesday: 60, wednesday: 60, thursday: 60, friday: 60, saturday: 120, sunday: 120 };
const config = {
  timezone: 'Europe/Berlin',
  users: [
    { id: 'kid', displayName: 'Kid', pin: '1234', role: 'user' as const, weeklyBudgetMinutes: budgets },
    { id: 'admin', displayName: 'Admin', pin: '9999', role: 'superuser' as const }
  ],
  devices: [{ id: 'tv', displayName: 'TV', aclRuleName: 'KC TV', appleTvIdentifier: 'id-tv' }]
};

describe('configuration and time domain', () => {
  it('accepts a valid config and derives the weekday budget', () => {
    expect(validateConfig(config)).toEqual(config);
    expect(budgetFor(config.users[0]!, new Date('2026-07-31T12:00:00Z'), config.timezone)).toBe(3600);
  });

  it.each([
    [{ ...config, timezone: 'UTC' }, 'timezone'],
    [{ ...config, users: [{ ...config.users[0], pin: '12' }] }, 'four digits'],
    [{ ...config, users: [...config.users, config.users[0]] }, 'unique'],
    [{ ...config, devices: [{ ...config.devices[0], aclRuleName: '' }] }, 'aclRuleName']
  ])('rejects unsafe config %#', (value, message) => {
    expect(() => validateConfig(value)).toThrow(message);
  });

  it('uses Europe/Berlin calendar days across UTC boundaries', () => {
    expect(berlinDay(new Date('2026-03-29T22:30:00Z'))).toBe('2026-03-30');
    expect(berlinDay(new Date('2026-10-25T22:30:00Z'))).toBe('2026-10-25');
  });

  it('formats non-negative durations', () => {
    expect(formatDuration(3661)).toBe('01:01:01');
    expect(formatDuration(-4)).toBe('00:00:00');
  });
});
