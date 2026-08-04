import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('mandatory accounting and reconciliation regressions', () => {
  let now: Date;
  let store: Store;
  let writes: Array<[string, boolean]>;
  let physical: Record<string, boolean>;
  let app: KidControl;

  beforeEach(async () => {
    now = new Date('2026-07-31T12:00:00.500Z');
    store = new Store(':memory:');
    writes = [];
    physical = { one: true, two: true };
    app = new KidControl(config, store, {
      read: async (id) => physical[id]!,
      setBlocked: async (id, blocked) => { writes.push([id, blocked]); physical[id] = blocked; }
    }, () => now);
    await app.powerChanged('one', 'on');
    await app.powerChanged('two', 'on');
  });
  afterEach(() => store.close());

  it('uses progressing epoch-second half-open intervals across Berlin midnight', async () => {
    now = new Date('2026-07-31T21:59:59.500Z');
    await app.start('a', 'one');
    now = new Date('2026-07-31T22:00:00.500Z');
    await app.stop('a');
    expect(store.usage('a', '2026-07-31')).toBe(1);
    expect(store.usage('a', '2026-08-01')).toBe(0);
  });

  it.each([
    ['spring transition', '2026-03-29T00:59:58.500Z', '2026-03-29T01:00:03.500Z'],
    ['fall transition', '2026-10-25T00:59:58.500Z', '2026-10-25T01:00:03.500Z']
  ])('accounts exactly across %s', async (_label, start, end) => {
    now = new Date(start); await app.start('a', 'one');
    now = new Date(end); await app.stop('a');
    expect(store.usage('a', new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(start)))).toBe(5);
  });

  it('caps a delayed tick at exact budget exhaustion', async () => {
    await app.start('a', 'one');
    now = new Date(now.getTime() + 65_000);
    await app.tick();
    const session = store.db.prepare('SELECT seconds, ended_at endedAt FROM usage_sessions').get() as { seconds: number; endedAt: number };
    expect(session.seconds).toBe(60);
    expect(session.endedAt).toBe(Math.floor(new Date('2026-07-31T12:00:00.500Z').getTime() / 1000) + 60);
    expect(store.activeClaims()).toEqual([]);
  });

  it('serializes concurrent start and stop so stale network completion cannot win', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    app = new KidControl(config, store, {
      read: async () => physical.one,
      setBlocked: async (_id, blocked) => { if (first) { first = false; await gate; } physical.one = blocked; }
    }, () => now);
    const starting = app.start('a', 'one');
    const stopping = app.stop('a');
    release();
    await Promise.all([starting, stopping]);
    expect(store.activeClaims()).toEqual([]);
    expect(physical.one).toBe(true);
  });

  it('adopts an external block atomically without any UniFi write', async () => {
    await app.start('a', 'one'); await app.start('b', 'one');
    writes.length = 0;
    now = new Date(now.getTime() + 4_000);
    await app.adoptAcl('one', true);
    expect(store.activeClaims()).toEqual([]);
    expect(writes).toEqual([]);
    expect(store.usage('a', '2026-07-31')).toBe(4);
    expect(store.usage('b', '2026-07-31')).toBe(4);
  });

  it('persists external allowance baseline through restart until restore', async () => {
    await app.adoptAcl('two', false);
    const restarted = new KidControl(config, store, { read: async () => false, setBlocked: async (id, blocked) => { writes.push([id, blocked]); } }, () => now);
    writes.length = 0;
    await restarted.recover();
    expect(writes).toEqual([]);
    expect(store.aclState('two')).toMatchObject({ baselineBlocked: false, actualBlocked: false, source: 'external' });
    await restarted.restore('root');
    expect(writes).toContainEqual(['two', true]);
  });

  it('rolls back a first claim with zero usage when unblock cannot be confirmed', async () => {
    app = new KidControl(config, store, { read: async () => true, setBlocked: async () => { throw new Error('offline'); } }, () => now);
    await expect(app.start('a', 'one')).rejects.toThrow('offline');
    expect(store.activeClaims()).toEqual([]);
    expect(store.usage('a', '2026-07-31')).toBe(0);
    expect(store.aclState('one')).toMatchObject({ desiredBlocked: true, pending: true, attempts: 2 });
  });

  it('preserves an adopted external allowance as the no-claim baseline after normal use', async () => {
    physical.two = false;
    await app.adoptAcl('two', false);
    await app.start('a', 'two');
    writes.length = 0;
    await app.stop('a');
    expect(physical.two).toBe(false);
    expect(writes).not.toContainEqual(['two', true]);
    expect(store.aclState('two')).toMatchObject({ baselineBlocked: false, desiredBlocked: false });
  });

  it('reads and adopts an external block before retrying pending work during recovery', async () => {
    physical.one = false;
    await app.start('a', 'one');
    store.setAcl({
      deviceId: 'one', desiredBlocked: false, actualBlocked: false, baselineBlocked: true,
      source: 'pending', pending: true, attempts: 1, lastError: 'timeout', nextRetryAt: null,
      updatedAt: Math.floor(now.getTime() / 1000)
    });
    physical.one = true;
    writes.length = 0;
    const restarted = new KidControl(config, store, {
      read: async () => physical.one,
      setBlocked: async (id, blocked) => { writes.push([id, blocked]); physical[id] = blocked; }
    }, () => now);
    await restarted.recover();
    expect(writes).toEqual([]);
    expect(store.activeClaims()).toEqual([]);
    expect(store.aclState('one')).toMatchObject({ source: 'external', actualBlocked: true });
  });

  it('does not retry pending ACL work before its durable backoff expires', async () => {
    const nowSecond = Math.floor(now.getTime() / 1000);
    store.setAcl({
      deviceId: 'one', desiredBlocked: true, actualBlocked: false, baselineBlocked: true,
      source: 'pending', pending: true, attempts: 3, lastError: 'offline', nextRetryAt: nowSecond + 60,
      updatedAt: nowSecond
    });
    physical.one = false;
    writes.length = 0;
    await app.poll();
    expect(writes).toEqual([]);
    expect(store.aclState('one')).toMatchObject({ pending: true, nextRetryAt: nowSecond + 60 });
  });

  it('reconciles the former device when an adjustment observes exact exhaustion', async () => {
    await app.start('a', 'one');
    writes.length = 0;
    now = new Date('2026-07-31T12:01:00.000Z');
    await app.setRemaining('root', 'a', 30);
    expect(store.activeClaims()).toEqual([]);
    expect(app.status('a').remainingSeconds).toBe(30);
    expect(physical.one).toBe(true);
    expect(writes).toContainEqual(['one', true]);
  });

  it('re-blocks after an ambiguous failed first activation that physically unblocked', async () => {
    let calls = 0;
    physical.one = true;
    app = new KidControl(config, store, {
      read: async (id) => physical[id]!,
      setBlocked: async (id, blocked) => {
        physical[id] = blocked;
        calls += 1;
        if (calls === 1) throw new Error('readback lost');
      }
    }, () => now);
    await expect(app.start('a', 'one')).rejects.toThrow('readback lost');
    expect(store.activeClaims()).toEqual([]);
    expect(store.usage('a', '2026-07-31')).toBe(0);
    expect(physical.one).toBe(true);
    expect(store.aclState('one')).toMatchObject({ desiredBlocked: true, actualBlocked: true, pending: false });
  });

  it('refuses recovery when a removed configured device may still be allowed', async () => {
    await app.start('a', 'one');
    const reduced = { ...config, devices: config.devices.filter((device) => device.id !== 'one') };
    const restarted = new KidControl(reduced, store, {
      read: async (id) => physical[id]!, setBlocked: async () => undefined
    }, () => now);
    await expect(restarted.recover()).rejects.toThrow(/removed managed device.*one/i);
    expect(store.claim('a')?.deviceId).toBe('one');
  });

  it('uses a versioned constrained SQLite schema and private file mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kidcontrol-'));
    const path = join(dir, 'state.sqlite');
    const disk = new Store(path);
    expect(disk.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 });
    expect(disk.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(disk.db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(disk.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ledger_user_day'").get()).toEqual({ name: 'ledger_user_day' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    disk.close();
  });
});
