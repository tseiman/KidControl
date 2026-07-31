import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleTvMonitor, parseCredentialMap } from './apple-tv.js';

class FakeTv extends EventEmitter {
  powerState = 'unknown';
  connectCompanion = vi.fn(async () => undefined);
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
    expect(one.close).toHaveBeenCalledOnce(); expect(two.close).toHaveBeenCalledOnce();
  });
});
