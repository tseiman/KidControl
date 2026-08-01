import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { Store } from './store.js';
import { KidControl } from './kid-control.js';
import { Auth } from './auth.js';
import { createKidControlServer } from './server.js';
import type { Config } from './domain.js';

const config: Config = { timezone: 'Europe/Berlin', users: [
  { id: 'kid', displayName: 'Kid', pin: '1234', role: 'user', weeklyBudgetMinutes: { monday: 10, tuesday: 10, wednesday: 10, thursday: 10, friday: 10, saturday: 10, sunday: 10 } },
  { id: 'root', displayName: 'Root', pin: '9999', role: 'superuser' }
], devices: [{ id: 'tv', displayName: 'Family TV', aclRuleName: 'KC TV', appleTvIdentifier: 'atv' }] };
const origin = 'https://kidcontrol.test';

describe('hardened HTTP API and local smoke journey', () => {
  let store: Store; let server: ReturnType<typeof createKidControlServer>; let base: string; let auth: Auth; let core: KidControl;
  beforeEach(async () => {
    store = new Store(':memory:');
    core = new KidControl(config, store, { read: async () => true, setBlocked: vi.fn(async () => undefined) }, () => new Date('2026-07-31T12:00:00Z'));
    auth = new Auth(store, () => config.users, Buffer.alloc(32, 9));
    server = createKidControlServer(config, core, auth, {
      publicDir: new URL('../public/', import.meta.url), documentation: '# KidControl\n\nSafe docs.',
      publicOrigin: origin, trustedProxyIp: '127.0.0.1'
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(async () => { server.close(); await once(server, 'close'); store.close(); });
  const headers = { host: 'kidcontrol.test', origin, 'x-forwarded-for': '192.0.2.10' };
  async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    return await new Promise<Response>((resolve, reject) => {
      const url = new URL(base + path);
      const req = request(url, { method: init.method ?? 'GET', headers: { connection: 'close', ...init.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
      });
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  }
  async function login(id = 'kid', pin = '1234', extra: Record<string, string> = {}) {
    const response = await call('/api/login', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ userId: id, pin }) });
    const body = await response.json() as { csrf: string };
    return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }

  it('rejects every wrong Host and every POST with a non-exact Origin', async () => {
    expect((await call('/health', { headers: { host: 'evil.test' } })).status).toBe(400);
    expect((await call('/api/login', { method: 'POST', headers: { host: 'kidcontrol.test', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('always sets __Host Secure cookie, no-store, and reload bootstrap rotates CSRF', async () => {
    const session = await login();
    const cookieHeader = session.response.headers.get('set-cookie')!;
    expect(cookieHeader).toContain('__Host-kidcontrol='); expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('HttpOnly'); expect(cookieHeader).toContain('SameSite=Strict'); expect(cookieHeader).toContain('Path=/');
    expect(session.response.headers.get('cache-control')).toBe('no-store');
    const boot = await call('/api/session', { headers: { host: 'kidcontrol.test', cookie: session.cookie } });
    const body = await boot.json() as { csrf: string; user: { id: string } };
    expect(body.user.id).toBe('kid'); expect(body.csrf).not.toBe(session.body.csrf);
    await core.powerChanged('tv', 'on');
    const claim = await call('/api/claim', { method: 'POST', headers: { ...headers, cookie: session.cookie, 'x-csrf-token': body.csrf, 'content-type': 'application/json' }, body: '{"deviceId":"tv"}' });
    expect(claim.status).toBe(204);
  });

  it('returns 429 plus Retry-After with the same invalid response shape', async () => {
    for (let index = 0; index < 5; index++) expect((await login('kid', '0000')).response.status).toBe(401);
    const limited = await login('kid', '1234');
    expect(limited.response.status).toBe(429); expect(limited.response.headers.get('retry-after')).toBe('900');
    expect(limited.body).toEqual({ error: 'invalid credentials' });
  });

  it('never leaks PINs and returns device power and ACL status without other regular claims', async () => {
    const publicResponse = await call('/api/public', { headers: { host: 'kidcontrol.test' } });
    const text = await publicResponse.text(); expect(text).not.toContain('1234');
    const session = await login();
    const status = await call('/api/status', { headers: { host: 'kidcontrol.test', cookie: session.cookie } });
    expect(await status.json()).toMatchObject({ devices: [{ id: 'tv', displayName: 'Family TV', power: 'unknown', acl: 'unknown' }] });
  });

  it('uses only a single validated client address supplied by the trusted proxy', async () => {
    const missing = await call('/api/login', {
      method: 'POST', headers: { host: 'kidcontrol.test', origin, 'content-type': 'application/json' },
      body: '{"userId":"kid","pin":"1234"}'
    });
    expect(missing.status).toBe(400);
    for (let index = 0; index < 5; index++) {
      const failed = await login(`missing-${index}`, '0000', { 'x-forwarded-for': '192.0.2.20' });
      expect(failed.response.status).toBe(401);
    }
    const independent = await login('root', '9999', { 'x-forwarded-for': '192.0.2.21' });
    expect(independent.response.status).toBe(200);
  });

  it('returns 403 when a regular user targets a device reserved by a superuser', async () => {
    await core.powerChanged('tv', 'on');
    const root = await login('root', '9999');
    await call('/api/claim', {
      method: 'POST',
      headers: { ...headers, cookie: root.cookie, 'x-csrf-token': root.body.csrf, 'content-type': 'application/json' },
      body: '{"deviceId":"tv"}'
    });
    const kid = await login();
    const response = await call('/api/claim', {
      method: 'POST',
      headers: { ...headers, cookie: kid.cookie, 'x-csrf-token': kid.body.csrf, 'content-type': 'application/json' },
      body: '{"deviceId":"tv"}'
    });
    expect(response.status).toBe(403);
  });

  it('rejects a regular claim unless power is confirmed on while allowing a superuser', async () => {
    const kid = await login();
    const denied = await call('/api/claim', {
      method: 'POST',
      headers: { ...headers, cookie: kid.cookie, 'x-csrf-token': kid.body.csrf, 'content-type': 'application/json' },
      body: '{"deviceId":"tv"}'
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: 'Apple TV is not on' });

    const root = await login('root', '9999');
    const allowed = await call('/api/claim', {
      method: 'POST',
      headers: { ...headers, cookie: root.cookie, 'x-csrf-token': root.body.csrf, 'content-type': 'application/json' },
      body: '{"deviceId":"tv"}'
    });
    expect(allowed.status).toBe(204);
  });

  it('rejects oversized Content-Length before reading and configures production timeouts', async () => {
    expect(server.requestTimeout).toBeGreaterThan(0); expect(server.headersTimeout).toBeGreaterThan(0);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + '/api/login', { method: 'POST', headers: { ...headers, 'content-length': '999999' } }, (res) => { resolve(res.statusCode!); res.resume(); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(413);
  });
});
