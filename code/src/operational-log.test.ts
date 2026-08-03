import { describe, expect, it } from 'vitest';
import { formatOperationalEvent } from './operational-log.js';

describe('operational key=value logging', () => {
  it('quotes and escapes untrusted string values while keeping typed values readable', () => {
    expect(formatOperationalEvent('session-start', {
      userId: 'anna',
      userName: 'Anna "Admin"\nSecond line\u2028third\u2029fourth',
      remainingSeconds: 7200,
      unlimited: false,
      optional: undefined
    })).toBe('event=session-start userId="anna" userName="Anna \\"Admin\\"\\nSecond line\\u2028third\\u2029fourth" remainingSeconds=7200 unlimited=false');
  });

  it('rejects invalid event and field names', () => {
    expect(() => formatOperationalEvent('bad event', {})).toThrow('invalid event name');
    expect(() => formatOperationalEvent('login', { 'bad key': 'value' })).toThrow('invalid field name');
  });
});
