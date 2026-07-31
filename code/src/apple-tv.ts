import { AppleTV, Credentials, scan, type DiscoveredDevice, type PowerStateChangedEvent } from 'node-appletv-remote';
import type { EventEmitter } from 'node:events';
import type { Power } from './kid-control.js';

type CredentialsLike = { companionCredentials?: unknown };
type TvLike = EventEmitter & {
  deviceId: string;
  powerState?: string;
  connectCompanion(credentials: unknown): Promise<void>;
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

  private async publish(deviceId: string, state: Power): Promise<void> {
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
    await Promise.all(this.devices.map((device) => this.connectDevice(device)));
  }

  private async connectDevice(device: { id: string; appleTvIdentifier: string }): Promise<void> {
    if (this.stopping) return;
    const credential = this.credentials.get(device.appleTvIdentifier)?.companionCredentials;
    if (!credential) {
      await this.publish(device.id, 'unknown');
      this.schedule(device);
      return;
    }
    try {
      let tv = this.active.get(device.id);
      if (!tv) {
        const found = await this.library.scan();
        const discovered = found.find((candidate) => candidate.deviceId === device.appleTvIdentifier);
        if (!discovered) throw new Error('not discovered');
        tv = this.library.create(discovered);
        this.active.set(device.id, tv);
        this.bind(device, tv);
      }
      await tv.connectCompanion(credential);
      this.delays.set(device.id, this.baseReconnectMs);
      const power = tv.powerState;
      await this.publish(device.id, power === 'on' || power === 'off' ? power : 'unknown');
    } catch (error) {
      await this.publish(device.id, 'unknown');
      this.schedule(device);
      console.error(`Apple TV ${device.id} unavailable`, error instanceof Error ? error.message : 'unknown error');
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
      const state = event.current as Power;
      if (state === 'on' || state === 'off' || state === 'unknown') void this.publish(device.id, state);
    });
    const disconnected = () => {
      if (this.stopping) return;
      void this.publish(device.id, 'unknown');
      this.schedule(device);
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
