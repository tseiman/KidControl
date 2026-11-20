import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleTvMonitor, parseCredentialMap } from './apple-tv.js';

class FakeTv extends EventEmitter {
  powerState = 'unknown';
  connectCompanion = vi.fn(async () => undefined);
  refreshPowerState = vi.fn(async () => this.powerState);
  close = vi.fn(async () => undefined);
  constructor(public deviceId: string) { super(); }
}
const credentials = '{"atv":"serialized","atv2":"serialized2"}';
const deserialize = vi.fn(() => ({ companionCredentials: { key: 'value' } }));

describe('resilient Apple TV monitoring', () => {
  afterEach(() => vi.useRealTimers());
  it('validates the credential map without exposing credentials', () => {
    expect(() => parseCredentialMap('[]', deserialize)).toThrow('JSON map');
    expect(() => parseCredentialMap('{"atv":"x"}', () => ({}))).toThrow('companionCredentials');
  });

  it('publishes unknown and starts degraded when scanning fails or a device is missing', async () => {
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan: vi.fn(async () => { throw new Error('offline'); }), deserialize, credentialText: credentials,
      create: (found) => found as FakeTv
    }, onPower, { baseReconnectMs: 10, maxReconnectMs: 40 });
    await expect(monitor.start()).resolves.toBeUndefined();
    expect(onPower).toHaveBeenCalledWith('one', 'unknown');
    await monitor.close();
  });

  it('initial connect failure does not abort startup and schedules one bounded reconnect', async () => {
    vi.useFakeTimers();
    const tv = new FakeTv('atv');
    tv.connectCompanion.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan: vi.fn(async () => [tv]), deserialize, credentialText: credentials, create: () => tv
    }, onPower, { baseReconnectMs: 10, maxReconnectMs: 40 });
    await monitor.start();
    tv.emit('companionClose'); tv.emit('companionError', new Error('again'));
    await vi.advanceTimersByTimeAsync(9);
    expect(tv.connectCompanion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tv.connectCompanion).toHaveBeenCalledTimes(2);
    await monitor.close();
  });

  it('coalesces concurrent refreshes and reuses a sufficiently fresh result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'));
    const tv = new FakeTv('atv');
    tv.powerState = 'on';
    let release!: () => void;
    tv.refreshPowerState.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'on';
    });
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan: vi.fn(async () => [tv]), deserialize, credentialText: credentials, create: () => tv
    }, onPower);
    await monitor.start();
    vi.setSystemTime(new Date('2026-07-31T12:00:11Z'));

    const first = monitor.refreshDevice('one', 10_000);
    const second = monitor.refreshDevice('one', 10_000);
    expect(tv.refreshPowerState).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['on', 'on']);
    await expect(monitor.refreshDevice('one', 10_000)).resolves.toBe('on');
    expect(tv.refreshPowerState).toHaveBeenCalledOnce();
    await monitor.close();
  });

  it('shares one discovery scan across devices connecting concurrently', async () => {
    const one = new FakeTv('atv');
    const two = new FakeTv('atv2');
    let release!: () => void;
    const scan = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return [one, two];
    });
    const monitor = new AppleTvMonitor([
      { id: 'one', appleTvIdentifier: 'atv' },
      { id: 'two', appleTvIdentifier: 'atv2' }
    ], {
      scan, deserialize, credentialText: credentials,
      create: (found) => found === one ? one : two
    }, vi.fn(async () => undefined));

    const starting = monitor.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scan).toHaveBeenCalledOnce();
    release();
    await starting;
    await monitor.close();
  });

  it('uses the fresh reconnect result without a duplicate power request', async () => {
    const tv = new FakeTv('atv');
    tv.powerState = 'on';
    const scan = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([tv]);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials, create: () => tv
    }, vi.fn(async () => undefined), { baseReconnectMs: 60_000, maxReconnectMs: 60_000 });

    await monitor.start();
    await expect(monitor.refreshDevice('one', 0)).resolves.toBe('on');
    expect(tv.connectCompanion).toHaveBeenCalledOnce();
    expect(tv.refreshPowerState).not.toHaveBeenCalled();
    await monitor.close();
  });

  it('invalidates a failed TV and rediscovers instead of reusing it', async () => {
    const stale = new FakeTv('atv');
    stale.powerState = 'on';
    stale.refreshPowerState.mockRejectedValueOnce(new Error('timed out'));
    const fresh = new FakeTv('atv');
    fresh.powerState = 'off';
    const scan = vi.fn()
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([fresh]);
    const create = vi.fn((found: { deviceId: string }) => found === stale ? stale : fresh);
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials, create
    }, onPower);
    await monitor.start();

    await expect(monitor.refreshDevice('one', 0)).resolves.toBe('off');
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.connectCompanion).toHaveBeenCalledOnce();
    expect(fresh.refreshPowerState).not.toHaveBeenCalled();
    stale.emit('powerStateChanged', { current: 'on' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onPower.mock.calls.at(-1)).toEqual(['one', 'off']);
    await monitor.close();
  });

  it('does not publish a connect result after that TV disconnected in flight', async () => {
    const stale = new FakeTv('atv');
    stale.powerState = 'on';
    let finishConnect!: () => void;
    stale.connectCompanion.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finishConnect = resolve; });
    });
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan: vi.fn(async () => [stale]), deserialize, credentialText: credentials, create: () => stale
    }, onPower, { baseReconnectMs: 60_000, maxReconnectMs: 60_000 });

    const starting = monitor.start();
    await new Promise((resolve) => setImmediate(resolve));
    stale.emit('companionClose');
    finishConnect();
    await starting;
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPower.mock.calls.some(([, state]) => state === 'on')).toBe(false);
    expect(onPower.mock.calls.at(-1)).toEqual(['one', 'unknown']);
    await monitor.close();
  });

  it('does not let a delayed stale disconnect overwrite a replacement result', async () => {
    const stale = new FakeTv('atv');
    stale.powerState = 'on';
    let finishClose!: () => void;
    stale.close.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finishClose = resolve; });
    });
    const fresh = new FakeTv('atv');
    fresh.powerState = 'off';
    const scan = vi.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([fresh]);
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials,
      create: (found) => found === stale ? stale : fresh
    }, onPower, { baseReconnectMs: 60_000, maxReconnectMs: 60_000 });
    await monitor.start();

    stale.emit('companionClose');
    await expect(monitor.refreshDevice('one', 0)).resolves.toBe('off');
    finishClose();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPower.mock.calls.at(-1)).toEqual(['one', 'off']);
    await monitor.close();
  });

  it('discards a refresh result from a TV disconnected while the request was in flight', async () => {
    const stale = new FakeTv('atv');
    stale.powerState = 'on';
    let release!: () => void;
    stale.refreshPowerState.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'on';
    });
    const fresh = new FakeTv('atv');
    fresh.powerState = 'off';
    const scan = vi.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([fresh]);
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials,
      create: (found) => found === stale ? stale : fresh
    }, onPower);
    await monitor.start();

    const refreshing = monitor.refreshDevice('one', 0);
    stale.emit('companionClose');
    await new Promise((resolve) => setImmediate(resolve));
    release();

    await expect(refreshing).resolves.toBe('off');
    expect(onPower.mock.calls.at(-1)).toEqual(['one', 'off']);
    await monitor.close();
  });

  it('fails closed when targeted refresh and rediscovery both fail', async () => {
    const tv = new FakeTv('atv');
    tv.powerState = 'on';
    tv.refreshPowerState.mockRejectedValueOnce(new Error('timed out'));
    const scan = vi.fn().mockResolvedValueOnce([tv]).mockRejectedValueOnce(new Error('offline'));
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials, create: () => tv
    }, onPower, { baseReconnectMs: 10, maxReconnectMs: 40 });
    await monitor.start();

    await expect(monitor.refreshDevice('one', 0)).rejects.toThrow('offline');
    expect(tv.close).toHaveBeenCalledOnce();
    expect(onPower.mock.calls.at(-1)).toEqual(['one', 'unknown']);
    await monitor.close();
  });

  it('cancels a pending reconnect when foreground refresh reconnects first', async () => {
    vi.useFakeTimers();
    const stale = new FakeTv('atv');
    stale.powerState = 'on';
    const fresh = new FakeTv('atv');
    fresh.powerState = 'on';
    const scan = vi.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([fresh]);
    const monitor = new AppleTvMonitor([{ id: 'one', appleTvIdentifier: 'atv' }], {
      scan, deserialize, credentialText: credentials,
      create: (found) => found === stale ? stale : fresh
    }, vi.fn(async () => undefined), { baseReconnectMs: 10, maxReconnectMs: 40 });
    await monitor.start();

    stale.emit('companionClose');
    await vi.advanceTimersByTimeAsync(0);
    await monitor.refreshDevice('one', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(fresh.connectCompanion).toHaveBeenCalledOnce();
    await monitor.close();
  });

  it('keeps devices independent, forwards only authoritative states, and resets backoff after success', async () => {
    vi.useFakeTimers();
    const one = new FakeTv('atv'); const two = new FakeTv('atv2');
    const onPower = vi.fn(async () => undefined);
    const monitor = new AppleTvMonitor([
      { id: 'one', appleTvIdentifier: 'atv' }, { id: 'two', appleTvIdentifier: 'atv2' }
    ], {
      scan: vi.fn(async () => [one, two]), deserialize, credentialText: credentials,
      create: (found) => found.deviceId === 'atv' ? one : two
    }, onPower, { baseReconnectMs: 10, maxReconnectMs: 40 });
    await monitor.start();
    one.emit('powerStateChanged', { current: 'off' });
    two.emit('powerStateChanged', { current: 'on' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onPower).toHaveBeenCalledWith('one', 'off');
    expect(onPower).toHaveBeenCalledWith('two', 'on');
    one.emit('companionClose');
    await vi.advanceTimersByTimeAsync(10);
    expect(one.connectCompanion).toHaveBeenCalledTimes(2);
    expect(two.connectCompanion).toHaveBeenCalledTimes(1);
    await monitor.close();
    expect(one.close).toHaveBeenCalledTimes(2); expect(two.close).toHaveBeenCalledOnce();
  });
});
