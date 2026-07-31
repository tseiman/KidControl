import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let now: Date; let store: Store; let acl: { setBlocked: ReturnType<typeof vi.fn> }; let app: KidControl;
  beforeEach(() => {
    now = new Date('2026-07-31T12:00:00Z');
    store = new Store(':memory:');
    acl = { setBlocked: vi.fn(async () => undefined) };
    app = new KidControl(config, store, acl, () => now);
  });
  afterEach(() => store.close());
  const advance = (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); };

  it('starts and stops a claim while accounting exact whole seconds', async () => {
    await app.start('a', 'one'); advance(5); await app.stop('a');
    expect(app.status('a').remainingSeconds).toBe(55);
    expect(store.activeClaims()).toEqual([]);
    expect(acl.setBlocked.mock.calls).toEqual([['one', false], ['one', true]]);
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

  it('restores desired ACL state only on explicit superuser reset', async () => {
    await app.adoptAcl('one', false); await app.restore('root');
    expect(acl.setBlocked.mock.calls).toContainEqual(['one', true]);
    await expect(app.restore('a')).rejects.toThrow('superuser');
  });
});
