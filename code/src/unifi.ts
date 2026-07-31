import { request as httpsRequest } from 'node:https';
import type { AclController } from './kid-control.js';

const ALLOWED = ['type', 'name', 'description', 'action', 'networkIdFilter', 'sourceFilter', 'destinationFilter', 'enforcingDeviceFilter', 'enabled'] as const;
type Rule = Record<string, unknown> & { id: string; name: string; enabled: boolean };
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface UniFiOptions { timeoutMs?: number; maxResponseBytes?: number; ca?: string | Buffer }

export function nativeHttpsFetch(ca: string | Buffer, maxResponseBytes: number, requester: typeof httpsRequest = httpsRequest): Fetch {
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input);
    let request: ReturnType<typeof httpsRequest>;
    request = requester(url, {
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      ca,
      rejectUnauthorized: true,
      signal: init.signal ?? undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      response.on('data', (raw: Buffer | Uint8Array | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.byteLength;
        if (size > maxResponseBytes) {
          settled = true;
          const error = new Error('UniFi response too large');
          response.destroy(error);
          request.destroy(error);
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          headers: response.headers as Record<string, string>
        }));
      });
    });
    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

function strictRule(value: unknown): Rule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid UniFi ACL rule');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || typeof candidate.name !== 'string' || typeof candidate.enabled !== 'boolean') {
    throw new Error('invalid UniFi ACL rule');
  }
  return candidate as Rule;
}

export class UniFiAclController implements AclController {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: Fetch;

  constructor(
    host: string,
    siteId: string,
    private readonly apiKey: string,
    private readonly devices: Array<{ id: string; aclRuleName: string }>,
    fetcher: Fetch = fetch,
    options: UniFiOptions = {}
  ) {
    const parsed = new URL(host);
    if (parsed.protocol !== 'https:') throw new Error('UNIFI_HOST must use HTTPS');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('UNIFI_HOST must be a canonical HTTPS origin');
    if (!apiKey) throw new Error('UNIFI_API_KEY is required');
    this.base = `${parsed.origin}/proxy/network/integration/v1/sites/${encodeURIComponent(siteId)}`;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.fetcher = options.ca ? nativeHttpsFetch(options.ca, this.maxResponseBytes) : fetcher;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'X-API-Key': this.apiKey,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers
          }
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error('UniFi request timed out');
        throw error;
      }
      if (!response.ok) throw new Error(`UniFi request failed with HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('invalid empty UniFi response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error('UniFi response too large');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error('invalid UniFi JSON response'); }
      const envelope = parsed as { data?: unknown };
      return envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  private configured(deviceId: string) {
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error('unknown managed device');
    return device;
  }

  private async find(deviceId: string): Promise<Rule> {
    const device = this.configured(deviceId);
    const data = await this.request('/acl-rules?limit=200');
    const rawRules = Array.isArray(data) ? data : (data as { items?: unknown[] })?.items;
    if (!Array.isArray(rawRules)) throw new Error('invalid UniFi ACL list response');
    const named = rawRules.filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === device.aclRuleName);
    if (named.length !== 1) throw new Error(`expected exactly one ACL named ${device.aclRuleName}, found ${named.length}`);
    return strictRule(named[0]);
  }

  async read(deviceId: string): Promise<boolean> { return (await this.find(deviceId)).enabled; }

  private async readById(id: string): Promise<Rule> {
    return strictRule(await this.request(`/acl-rules/${encodeURIComponent(id)}`));
  }

  async setBlocked(deviceId: string, blocked: boolean): Promise<void> {
    const rule = await this.find(deviceId);
    const payload: Record<string, unknown> = {};
    for (const key of ALLOWED) if (key in rule) payload[key] = key === 'enabled' ? blocked : rule[key];
    try {
      await this.request(`/acl-rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    } catch (putError) {
      const disambiguated = await this.readById(rule.id);
      if (disambiguated.enabled === blocked) return;
      throw putError;
    }
    const readback = await this.readById(rule.id);
    if (readback.enabled !== blocked) throw new Error('UniFi ACL readback did not match requested state');
  }
}
