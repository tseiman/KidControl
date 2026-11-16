import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Config } from './domain.js';
import { KidControl } from './kid-control.js';
import { Store } from './store.js';

const budget = { monday: 600, tuesday: 600, wednesday: 600, thursday: 600, friday: 600, saturday: 600, sunday: 600 };
const config: Config = {
  timezone: 'Europe/Berlin',
  users: [
    { id: 'kid', displayName: 'Kid', pin: '1234', role: 'user', weeklyBudgetMinutes: budget },
    { id: 'root', displayName: 'Root', pin: '9999', role: 'superuser' }
  ],
  devices: [
    { id: 'tv', displayName: 'TV', aclRuleName: 'TV rule', appleTvIdentifier: 'tv' },
    { id: 'tablet', displayName: 'Tablet', aclRuleName: 'Tablet rule', appleTvIdentifier: 'tablet' },
    { id: 'idle', displayName: 'Idle', aclRuleName: 'Idle rule', appleTvIdentifier: 'idle' }
  ]
};

describe('daily reset policy', () => {
  let now: Date;
  let store: Store;
  let setBlocked: Mock<(deviceId: string, blocked: boolean) => Promise<void>>;
  let core: KidControl;

  beforeEach(async () => {
    now = new Date('2026-07-31T10:00:00Z'); // 12:00 Europe/Berlin
    store = new Store(':memory:');
    setBlocked = vi.fn(async () => undefined);
    core = new KidControl(config, store, { read: async () => false, setBlocked }, () => now);
    await core.powerChanged('tv', 'on');
    await core.powerChanged('tablet', 'on');
  });
  afterEach(() => store.close());

  it('accepts only strict HH:MM values from superusers and schedules changes strictly in the future', async () => {
    await expect(core.setDailyReset('kid', '08:15')).rejects.toThrow('superuser required');
    for (const invalid of ['8:15', '24:00', '12:60', '12:00:00', '', ' 12:00']) {
      await expect(core.setDailyReset('root', invalid)).rejects.toThrow('daily reset time must be HH:MM');
    }

    await core.setDailyReset('root', '09:30');
    expect(core.dailyResetTime()).toBe('09:30');
    expect(store.dailyReset().nextResetAt).toBe(Math.floor(new Date('2026-08-01T07:30:00Z').getTime() / 1000));
    await core.tick();
    expect(store.db.prepare("SELECT COUNT(*) count FROM audit WHERE event='automatic-reset'").get()).toEqual({ count: 0 });
  });

  it('ends regular and superuser claims at the boundary and forces every device baseline to blocked', async () => {
    await core.setDailyReset('root', '14:00');
    await core.start('kid', 'tv');
    await core.start('root', 'tablet');
    now = new Date('2026-07-31T12:00:10Z');

    await core.tick();

    expect(store.activeClaims()).toEqual([]);
    expect(store.usage('kid', '2026-07-31')).toBe(7_200);
    expect(store.usage('root', '2026-07-31')).toBe(7_200);
    expect(store.aclState('tv')).toMatchObject({ baselineBlocked: true, desiredBlocked: true, actualBlocked: true, pending: false });
    expect(store.aclState('tablet')).toMatchObject({ baselineBlocked: true, desiredBlocked: true, actualBlocked: true, pending: false });
    expect(store.aclState('idle')).toMatchObject({ baselineBlocked: true, desiredBlocked: true, actualBlocked: true, pending: false });
    const reset = store.db.prepare("SELECT data,created_at createdAt FROM audit WHERE event='automatic-reset'").get() as { data: string; createdAt: number };
    const boundary = Math.floor(new Date('2026-07-31T12:00:00Z').getTime() / 1000);
    expect(JSON.parse(reset.data)).toMatchObject({ scheduledAt: boundary, claimsEnded: 2 });
    expect(reset.createdAt).toBe(boundary);
  });

  it('does not advance the persisted occurrence before blocking work has been attempted', async () => {
    await core.setDailyReset('root', '14:00');
    await core.start('kid', 'tv');
    now = new Date('2026-07-31T12:00:10Z');
    const boundary = store.dailyReset().nextResetAt;
    let releaseFirstBlock!: () => void;
    setBlocked.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstBlock = resolve; }));

    const resetting = core.tick();
    await vi.waitFor(() => expect(setBlocked).toHaveBeenCalled());

    expect(store.dailyReset().nextResetAt).toBe(boundary);
    releaseFirstBlock();
    await resetting;
    expect(store.dailyReset().nextResetAt).toBeGreaterThan(boundary!);
  });

  it('enforces a due boundary before a manual action can account beyond it', async () => {
    await core.setDailyReset('root', '14:00');
    await core.start('kid', 'tv');
    now = new Date('2026-07-31T12:00:10Z');

    await core.stop('kid');

    expect(store.usage('kid', '2026-07-31')).toBe(7_200);
    expect(store.activeClaims()).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) count FROM audit WHERE event='automatic-reset'").get()).toEqual({ count: 1 });
  });

  it('applies an already-due old schedule before saving a replacement schedule', async () => {
    await core.setDailyReset('root', '14:00');
    await core.start('kid', 'tv');
    now = new Date('2026-07-31T12:00:10Z');

    await core.setDailyReset('root', '09:30');

    expect(store.usage('kid', '2026-07-31')).toBe(7_200);
    expect(store.activeClaims()).toEqual([]);
    expect(store.dailyReset()).toEqual({
      time: '09:30',
      nextResetAt: Math.floor(new Date('2026-08-01T07:30:00Z').getTime() / 1000)
    });
  });

  it('applies a missed occurrence once during recovery, preserves unrelated state, and leaves failed blocking durable for retry', async () => {
    await core.setDailyReset('root', '14:00');
    await core.start('kid', 'tv');
    store.addAdjustment('kid', '2026-07-31', 300, 'root', Math.floor(now.getTime() / 1000));
    store.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,auth_fingerprint,csrf,created_at) VALUES(?,?,?,?,?)')
      .run('a'.repeat(64), 'kid', 'b'.repeat(64), 'csrf-value', Math.floor(now.getTime() / 1000));
    store.db.prepare("INSERT INTO auth_attempts(dimension,key,attempted_at) VALUES('user','kid',?)")
      .run(Math.floor(now.getTime() / 1000));
    now = new Date('2026-07-31T12:05:00Z');
    setBlocked.mockImplementationOnce(async () => { throw new Error('offline'); });

    const restarted = new KidControl(config, store, { read: async () => false, setBlocked }, () => now);
    await restarted.recover();

    expect(store.activeClaims()).toEqual([]);
    expect(store.usage('kid', '2026-07-31')).toBe(7_200);
    expect(store.adjustmentTotal('kid', '2026-07-31')).toBe(300);
    expect(store.db.prepare('SELECT COUNT(*) count FROM auth_sessions').get()).toEqual({ count: 1 });
    expect(store.db.prepare('SELECT COUNT(*) count FROM auth_attempts').get()).toEqual({ count: 1 });
    expect(store.aclState('tv')).toMatchObject({ baselineBlocked: true, desiredBlocked: true, pending: true, lastError: 'offline' });
    expect(store.db.prepare("SELECT COUNT(*) count FROM audit WHERE event='automatic-reset'").get()).toEqual({ count: 1 });

    now = new Date('2026-07-31T12:05:10Z');
    await restarted.tick();
    expect(store.aclState('tv')).toMatchObject({ actualBlocked: true, pending: false });
    expect(store.db.prepare("SELECT COUNT(*) count FROM audit WHERE event='automatic-reset'").get()).toEqual({ count: 1 });
  });
});
