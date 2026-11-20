import { AppleTV, Credentials, scan, type DiscoveredDevice, type PowerStateChangedEvent } from 'node-appletv-remote';
import type { EventEmitter } from 'node:events';
import type { Power } from './kid-control.js';

type CredentialsLike = { companionCredentials?: unknown };
type TvLike = EventEmitter & {
  deviceId: string;
  powerState?: string;
  connectCompanion(credentials: unknown): Promise<void>;
  refreshPowerState(): Promise<string>;
  close(): Promise<void> | void;
};
interface Library {
  scan: () => Promise<Array<{ deviceId: string }>>;
  deserialize: (text: string) => CredentialsLike;
  credentialText: string;
  create: (found: { deviceId: string }) => TvLike;
}
interface MonitorOptions { baseReconnectMs?: number; maxReconnectMs?: number }

export function parseCredentialMap(
  text: string,
  deserialize: (value: string) => CredentialsLike = Credentials.deserialize
): Map<string, CredentialsLike> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Apple TV credentials file must contain valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Apple TV credentials file must be a JSON map');
  const result = new Map<string, CredentialsLike>();
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`credential for ${id} must be serialized text`);
    const credential = deserialize(value);
    if (!credential.companionCredentials) throw new Error(`credential for ${id} does not include companionCredentials`);
    result.set(id, credential);
  }
  return result;
}

export class AppleTvMonitor {
  private readonly active = new Map<string, TvLike>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly delays = new Map<string, number>();
  private readonly connecting = new Map<string, Promise<TvLike>>();
  private readonly refreshing = new Map<string, Promise<Power>>();
  private readonly lastPower = new Map<string, Power>();
  private readonly lastConfirmedAt = new Map<string, number>();
  private scanning: Promise<Array<{ deviceId: string }>> | undefined;
  private readonly baseReconnectMs: number;
  private readonly maxReconnectMs: number;
  private credentials = new Map<string, CredentialsLike>();
  private stopping = false;

  constructor(
    private readonly devices: Array<{ id: string; appleTvIdentifier: string }>,
    private readonly library: Library,
    private readonly onPower: (deviceId: string, state: Power) => Promise<void> | void,
    options: MonitorOptions | number = {}
  ) {
    this.baseReconnectMs = typeof options === 'number' ? options : options.baseReconnectMs ?? 5_000;
    this.maxReconnectMs = typeof options === 'number' ? Math.max(options, 300_000) : options.maxReconnectMs ?? 300_000;
  }

  static production(
    devices: Array<{ id: string; appleTvIdentifier: string }>,
    credentialText: string,
    onPower: (deviceId: string, state: Power) => Promise<void> | void
  ): AppleTvMonitor {
    return new AppleTvMonitor(devices, {
      scan: () => scan({ timeout: 5_000 }),
      deserialize: Credentials.deserialize,
      credentialText,
      create: (found) => new AppleTV(found as DiscoveredDevice)
    }, onPower);
  }

  private async publish(deviceId: string, state: Power, confirmed = false): Promise<void> {
    this.lastPower.set(deviceId, state);
    if (confirmed && (state === 'on' || state === 'off')) this.lastConfirmedAt.set(deviceId, Date.now());
    if (state === 'unknown') this.lastConfirmedAt.delete(deviceId);
    try { await this.onPower(deviceId, state); }
    catch (error) { console.error('Apple TV power callback failed', error instanceof Error ? error.message : 'unknown error'); }
  }

  async start(): Promise<void> {
    try { this.credentials = parseCredentialMap(this.library.credentialText, this.library.deserialize); }
    catch (error) {
      for (const device of this.devices) await this.publish(device.id, 'unknown');
      console.error('Apple TV credentials unavailable', error instanceof Error ? error.message : 'invalid credentials');
      return;
    }
    await Promise.all(this.devices.map((device) => this.connectDevice(device).catch(() => undefined)));
  }

  private device(deviceId: string): { id: string; appleTvIdentifier: string } {
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error(`unknown Apple TV device: ${deviceId}`);
    return device;
  }

  private async connectDevice(device: { id: string; appleTvIdentifier: string }): Promise<TvLike> {
    const pending = this.connecting.get(device.id);
    if (pending) return pending;
    const connection = this.connectDeviceOnce(device).finally(() => {
      if (this.connecting.get(device.id) === connection) this.connecting.delete(device.id);
    });
    this.connecting.set(device.id, connection);
    return connection;
  }

  private async connectDeviceOnce(device: { id: string; appleTvIdentifier: string }): Promise<TvLike> {
    if (this.stopping) throw new Error('Apple TV monitor is stopping');
    const credential = this.credentials.get(device.appleTvIdentifier)?.companionCredentials;
    if (!credential) {
      await this.publish(device.id, 'unknown');
      this.schedule(device);
      throw new Error('companion credentials unavailable');
    }
    let tv = this.active.get(device.id);
    try {
      if (!tv) {
        const found = await this.scan();
        const discovered = found.find((candidate) => candidate.deviceId === device.appleTvIdentifier);
        if (!discovered) throw new Error('not discovered');
        tv = this.library.create(discovered);
        this.active.set(device.id, tv);
        this.bind(device, tv);
      }
      await tv.connectCompanion(credential);
      if (this.stopping || this.active.get(device.id) !== tv) {
        throw new Error('Apple TV connection changed while connecting');
      }
      const reconnectTimer = this.timers.get(device.id);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      this.timers.delete(device.id);
      this.delays.set(device.id, this.baseReconnectMs);
      const power = tv.powerState;
      const state = power === 'on' || power === 'off' ? power : 'unknown';
      await this.publish(device.id, state, state !== 'unknown');
      return tv;
    } catch (error) {
      if (tv) await this.invalidate(device.id, tv);
      if (!this.active.has(device.id)) {
        await this.publish(device.id, 'unknown');
        this.schedule(device);
      }
      console.error(`Apple TV ${device.id} unavailable`, error instanceof Error ? error.message : 'unknown error');
      throw error;
    }
  }

  private scan(): Promise<Array<{ deviceId: string }>> {
    if (this.scanning) return this.scanning;
    const pending = this.library.scan().finally(() => {
      if (this.scanning === pending) this.scanning = undefined;
    });
    this.scanning = pending;
    return pending;
  }

  private async invalidate(deviceId: string, tv: TvLike): Promise<void> {
    if (this.active.get(deviceId) !== tv) return;
    this.active.delete(deviceId);
    this.lastConfirmedAt.delete(deviceId);
    try { await tv.close(); } catch { /* best effort invalidation */ }
  }

  async refreshDevice(deviceId: string, maxAgeMs = 10_000): Promise<Power> {
    const confirmedAt = this.lastConfirmedAt.get(deviceId);
    const cached = this.lastPower.get(deviceId);
    if (maxAgeMs > 0 && cached && confirmedAt !== undefined && Date.now() - confirmedAt <= maxAgeMs) return cached;
    const pending = this.refreshing.get(deviceId);
    if (pending) return pending;
    const refresh = this.refreshDeviceOnce(this.device(deviceId)).finally(() => {
      if (this.refreshing.get(deviceId) === refresh) this.refreshing.delete(deviceId);
    });
    this.refreshing.set(deviceId, refresh);
    return refresh;
  }

  async refreshAll(maxAgeMs = 10_000): Promise<void> {
    await Promise.allSettled(this.devices.map((device) => this.refreshDevice(device.id, maxAgeMs)));
  }

  private async refreshDeviceOnce(device: { id: string; appleTvIdentifier: string }): Promise<Power> {
    let tv = this.active.get(device.id);
    if (!tv) {
      tv = await this.connectDevice(device);
      const connectedState = this.lastPower.get(device.id);
      if (this.lastConfirmedAt.has(device.id) && (connectedState === 'on' || connectedState === 'off')) {
        return connectedState;
      }
    }
    try {
      const result = await tv.refreshPowerState();
      if (this.active.get(device.id) !== tv) throw new Error('Apple TV connection changed during refresh');
      const state: Power = result === 'on' || result === 'off' ? result : 'unknown';
      await this.publish(device.id, state, state !== 'unknown');
      if (state === 'unknown') throw new Error('Apple TV power state is unknown');
      return state;
    } catch (firstError) {
      await this.invalidate(device.id, tv);
      await this.publish(device.id, 'unknown');
      try {
        const replacement = await this.connectDevice(device);
        const connectedState = this.lastPower.get(device.id);
        if (this.lastConfirmedAt.has(device.id) && (connectedState === 'on' || connectedState === 'off')) {
          return connectedState;
        }
        const result = await replacement.refreshPowerState();
        if (this.active.get(device.id) !== replacement) throw new Error('Apple TV connection changed during refresh');
        const state: Power = result === 'on' || result === 'off' ? result : 'unknown';
        await this.publish(device.id, state, state !== 'unknown');
        if (state === 'unknown') throw new Error('Apple TV power state is unknown');
        return state;
      } catch (error) {
        await this.publish(device.id, 'unknown');
        throw error instanceof Error ? error : firstError;
      }
    }
  }

  private schedule(device: { id: string; appleTvIdentifier: string }): void {
    if (this.stopping || this.timers.has(device.id)) return;
    const delay = this.delays.get(device.id) ?? this.baseReconnectMs;
    this.delays.set(device.id, Math.min(this.maxReconnectMs, delay * 2));
    const timer = setTimeout(() => {
      this.timers.delete(device.id);
      void this.connectDevice(device).catch((error) => {
        console.error('Apple TV reconnect failed', error instanceof Error ? error.message : 'unknown error');
      });
    }, delay);
    this.timers.set(device.id, timer);
  }

  private bind(device: { id: string; appleTvIdentifier: string }, tv: TvLike): void {
    tv.on('powerStateChanged', (event: PowerStateChangedEvent) => {
      if (this.active.get(device.id) !== tv) return;
      const state = event.current as Power;
      if (state === 'on' || state === 'off' || state === 'unknown') void this.publish(device.id, state, state !== 'unknown');
    });
    const disconnected = () => {
      if (this.stopping || this.active.get(device.id) !== tv) return;
      void (async () => {
        await this.invalidate(device.id, tv);
        if (this.active.has(device.id)) return;
        await this.publish(device.id, 'unknown');
        this.schedule(device);
      })();
    };
    tv.on('companionClose', disconnected);
    tv.on('companionError', disconnected);
    tv.on('error', disconnected);
    tv.on('close', disconnected);
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.active.values()].map(async (tv) => {
      try { await tv.close(); } catch { /* best effort shutdown */ }
    }));
    this.active.clear();
  }
}
