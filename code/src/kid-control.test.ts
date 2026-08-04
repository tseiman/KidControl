import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Store } from './store.js';
import { KidControl } from './kid-control.js';
import type { Config } from './domain.js';

const week = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1 };
const config: Config = {
  timezone: 'Europe/Berlin',
  users: [
    { id: 'a', displayName: 'A', pin: '1111', role: 'user', weeklyBudgetMinutes: week },
    { id: 'b', displayName: 'B', pin: '2222', role: 'user', weeklyBudgetMinutes: week },
    { id: 'root', displayName: 'Root', pin: '9999', role: 'superuser' }
  ],
  devices: [
    { id: 'one', displayName: 'One', aclRuleName: 'KC One', appleTvIdentifier: 'atv1' },
    { id: 'two', displayName: 'Two', aclRuleName: 'KC Two', appleTvIdentifier: 'atv2' }
  ]
};

describe('claim, accounting and reconciliation policy', () => {
  let now: Date; let store: Store; let acl: { read: (deviceId: string) => Promise<boolean>; setBlocked: Mock<(deviceId: string, blocked: boolean) => Promise<void>> }; let app: KidControl;
  beforeEach(async () => {
    now = new Date('2026-07-31T12:00:00Z');
    store = new Store(':memory:');
    acl = { read: async () => false, setBlocked: vi.fn(async () => undefined) };
    app = new KidControl(config, store, acl, () => now);
    await app.powerChanged('one', 'on');
    await app.powerChanged('two', 'on');
  });
  afterEach(() => store.close());
  const advance = (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); };

  it('starts and stops a claim while accounting exact whole seconds', async () => {
    await app.start('a', 'one'); advance(5); await app.stop('a');
    expect(app.status('a').remainingSeconds).toBe(55);
    expect(store.activeClaims()).toEqual([]);
    expect(acl.setBlocked.mock.calls).toEqual([['one', false], ['one', true]]);
  });

  it('logs daily budgets, quarter-hour progress, standby stops, and superuser changes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await app.setRemaining('root', 'a', 1200);
      await app.start('a', 'one');
      await app.poll();
      advance(900);
      await app.poll();
      await app.powerChanged('one', 'off');
      await app.setRemaining('root', 'a', 30);
      const lines = info.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.startsWith('event=budget-change ') && line.includes('reason="daily"') && line.includes('userId="a"') && line.includes('amountSeconds=60'))).toBe(true);
      expect(lines.some((line) => line.startsWith('event=session-progress ') && line.includes('userId="a"') && line.includes('deviceId="one"'))).toBe(true);
      expect(lines.some((line) => line.startsWith('event=session-stop ') && line.includes('userId="a"') && line.includes('deviceId="one"') && line.includes('reason="apple-tv-off"'))).toBe(true);
      expect(lines.some((line) => line.startsWith('event=budget-change ') && line.includes('reason="superuser"') && line.includes('userId="a"') && line.includes('authorId="root"') && line.includes('remainingSeconds=30'))).toBe(true);
    } finally { info.mockRestore(); }
  });

  it('keeps a shared device allowed until its last claim ends', async () => {
    await app.start('a', 'one'); await app.start('b', 'one');
    await app.stop('a'); expect(acl.setBlocked).not.toHaveBeenLastCalledWith('one', true);
    await app.stop('b'); expect(acl.setBlocked).toHaveBeenLastCalledWith('one', true);
  });

  it('switches one user atomically between devices and blocks the abandoned device', async () => {
    await app.start('a', 'one'); advance(3); await app.start('a', 'two');
    expect(store.activeClaims().map((c) => c.deviceId)).toEqual(['two']);
    expect(app.status('a').remainingSeconds).toBe(57);
    expect(acl.setBlocked.mock.calls).toContainEqual(['one', true]);
  });

  it('refuses an exhausted regular claim and expires one on tick', async () => {
    await app.start('a', 'one'); advance(60); await app.tick();
    expect(store.activeClaims()).toEqual([]);
    await expect(app.start('a', 'one')).rejects.toThrow('budget exhausted');
  });

  it('superuser displaces regular users but standby ends only regular claims', async () => {
    await app.start('a', 'one'); await app.start('root', 'one');
    expect(store.activeClaims().map((c) => c.userId)).toEqual(['root']);
    await app.powerChanged('one', 'off');
    expect(store.activeClaims().map((c) => c.userId)).toEqual(['root']);
  });

  it('unknown and on power states never end claims', async () => {
    await app.start('a', 'one'); await app.powerChanged('one', 'unknown'); await app.powerChanged('one', 'on');
    expect(store.activeClaims()).toHaveLength(1);
  });

  it('requires confirmed power on for regular users but not for superusers', async () => {
    await app.powerChanged('one', 'unknown');
    await expect(app.start('a', 'one')).rejects.toThrow('Apple TV is not on');
    expect(store.activeClaims()).toEqual([]);

    await app.start('root', 'one');
    await app.stop('root');
    await app.powerChanged('one', 'off');

    await expect(app.start('a', 'one')).rejects.toThrow('Apple TV is not on');
    await expect(app.start('root', 'one')).resolves.toBeUndefined();
  });

  it('sets remaining time directly, identifies the author, and can restore exhausted time', async () => {
    await app.setRemaining('root', 'a', 30); expect(app.status('a').remainingSeconds).toBe(30);
    await app.setRemaining('root', 'a', 0); expect(store.activeClaims()).toEqual([]);
    await app.setRemaining('root', 'a', 90); expect(app.status('a').remainingSeconds).toBe(90);
    expect(store.adjustments('a')[0]?.authorId).toBe('root');
  });

  it('recovers active claims after restart and charges the outage interval', async () => {
    await app.start('a', 'one'); advance(7);
    const restarted = new KidControl(config, store, acl, () => now);
    await restarted.recover();
    expect(restarted.status('a').remainingSeconds).toBe(53);
    expect(store.activeClaims()).toHaveLength(1);
  });

  it('adopts an external block by ending claims and records an external allowance without claims', async () => {
    await app.start('a', 'one'); advance(4); await app.adoptAcl('one', true);
    expect(store.activeClaims()).toEqual([]); expect(app.status('a').remainingSeconds).toBe(56);
    await app.adoptAcl('two', false);
    expect(store.aclState('two')).toMatchObject({ actualBlocked: false, source: 'external' });
  });

  it('persists desired versus actual ACL state when an external write fails', async () => {
    const failing = new KidControl(config, store, { setBlocked: vi.fn(async () => { throw new Error('offline'); }) }, () => now);
    await expect(failing.start('a', 'one')).rejects.toThrow('offline');
    expect(store.aclState('one')).toMatchObject({ desiredBlocked: true, actualBlocked: null, source: 'pending' });
  });

  it('returns seven chronological Berlin calendar days ending today with zero-filled usage', () => {
    for (const [index, day, seconds] of [
      [1, '2026-07-25', 600],
      [2, '2026-07-28', 3_600],
      [3, '2026-07-31', 1_800],
      [4, '2026-07-24', 9_999],
      [5, '2026-07-28', 600]
    ] as const) {
      const sessionId = `history-${index}`;
      store.db.prepare('INSERT INTO usage_sessions(id,user_id,device_id,day,started_at,accounted_at,ended_at,end_reason,seconds) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(sessionId, 'a', 'one', day, index, index + seconds, index + seconds, 'test', seconds);
      store.db.prepare('INSERT INTO ledger(user_id,day,seconds,session_id,created_at) VALUES(?,?,?,?,?)')
        .run('a', day, seconds, sessionId, index + seconds);
    }

    expect(app.usageHistory('a')).toEqual([
      { day: '2026-07-25', seconds: 600 },
      { day: '2026-07-26', seconds: 0 },
      { day: '2026-07-27', seconds: 0 },
      { day: '2026-07-28', seconds: 4_200 },
      { day: '2026-07-29', seconds: 0 },
      { day: '2026-07-30', seconds: 0 },
      { day: '2026-07-31', seconds: 1_800 }
    ]);
  });

  it.each([
    ['year boundary', '2027-01-02T12:00:00Z', ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']],
    ['spring DST week', '2026-03-31T12:00:00Z', ['2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']]
  ])('keeps seven calendar dates across a %s', (_label, instant, expectedDays) => {
    now = new Date(instant);
    expect(app.usageHistory('a').map((entry) => entry.day)).toEqual(expectedDays);
  });

  it('restores desired ACL state only on explicit superuser reset', async () => {
    await app.adoptAcl('one', false); await app.restore('root');
    expect(acl.setBlocked.mock.calls).toContainEqual(['one', true]);
    await expect(app.restore('a')).rejects.toThrow('superuser');
  });
});
