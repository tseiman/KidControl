import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.js';
import { KidControl } from './kid-control.js';
import { Auth } from './auth.js';
import { createKidControlServer } from './server.js';
import type { Config } from './domain.js';

const config: Config = { timezone: 'Europe/Berlin', users: [
  { id: 'kid', displayName: 'Kid', icon: 'kid.webp', pin: '1234', role: 'user', weeklyBudgetMinutes: { monday: 10, tuesday: 10, wednesday: 10, thursday: 10, friday: 10, saturday: 10, sunday: 10 } },
  { id: 'root', displayName: 'Root', pin: '9999', role: 'superuser' }
], devices: [{ id: 'tv', displayName: 'Family TV', aclRuleName: 'KC TV', appleTvIdentifier: 'atv' }] };
const origin = 'https://kidcontrol.test';

describe('hardened HTTP API and local smoke journey', () => {
  let store: Store; let server: ReturnType<typeof createKidControlServer>; let base: string; let auth: Auth; let core: KidControl; let iconDir: string;
  beforeEach(async () => {
    iconDir = mkdtempSync(join(tmpdir(), 'kidcontrol-icons-'));
    writeFileSync(join(iconDir, 'kid.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    store = new Store(':memory:');
    core = new KidControl(config, store, { read: async () => true, setBlocked: vi.fn(async () => undefined) }, () => new Date('2026-07-31T12:00:00Z'));
    auth = new Auth(store, () => config.users, Buffer.alloc(32, 9));
    server = createKidControlServer(config, core, auth, {
      publicDir: new URL('../public/', import.meta.url), documentation: '# KidControl\n\nSafe docs.',
      publicOrigin: origin, trustedProxyIp: '127.0.0.1', iconDir
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(async () => { server.close(); await once(server, 'close'); store.close(); rmSync(iconDir, { recursive: true }); });
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

  it('logs successful login with client IP and budget actions without credentials', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const session = await login();
      await core.powerChanged('tv', 'on');
      await call('/api/claim', { method: 'POST', headers: { ...headers, cookie: session.cookie, 'x-csrf-token': session.body.csrf, 'content-type': 'application/json' }, body: '{"deviceId":"tv"}' });
      await call('/api/stop', { method: 'POST', headers: { ...headers, cookie: session.cookie, 'x-csrf-token': session.body.csrf, 'content-type': 'application/json' }, body: '{}' });
      const lines = info.mock.calls.map(([line]) => String(line));
      expect(lines).toContain('event=login userId="kid" userName="Kid" clientIp="192.0.2.10"');
      expect(lines).toContain('event=session-start userId="kid" userName="Kid" deviceId="tv" deviceName="Family TV" unlimited=false remainingSeconds=600');
      expect(lines).toContain('event=session-stop userId="kid" userName="Kid" deviceId="tv" deviceName="Family TV" reason="manual" unlimited=false remainingSeconds=600');
      expect(lines.join(' ')).not.toContain('1234');
    } finally { info.mockRestore(); }
  });

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

  it('serves configured login avatars without authentication and never leaks PINs', async () => {
    const publicResponse = await call('/api/public', { headers: { host: 'kidcontrol.test' } });
    const text = await publicResponse.text(); expect(text).not.toContain('1234');
    const publicBody = JSON.parse(text) as { users: Array<{ id: string; displayName: string; iconUrl?: string }> };
    expect(publicBody.users.find((user) => user.id === 'kid')).toEqual({ id: 'kid', displayName: 'Kid', iconUrl: '/api/user-icons/kid' });
    expect(text).not.toContain('kid.webp');
    const icon = await call('/api/user-icons/kid', { headers: { host: 'kidcontrol.test' } });
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    expect((await call('/api/user-icons/root', { headers: { host: 'kidcontrol.test' } })).status).toBe(404);
    writeFileSync(join(iconDir, 'outside.webp'), Buffer.from([1]));
    rmSync(join(iconDir, 'kid.webp'));
    symlinkSync(join(iconDir, 'outside.webp'), join(iconDir, 'kid.webp'));
    expect((await call('/api/user-icons/kid', { headers: { host: 'kidcontrol.test' } })).status).toBe(404);
    const session = await login();
    const status = await call('/api/status', { headers: { host: 'kidcontrol.test', cookie: session.cookie } });
    expect(await status.json()).toMatchObject({ devices: [{ id: 'tv', displayName: 'Family TV', power: 'unknown', acl: 'unknown' }] });
  });

  it('serves the browser policy and localization modules used by the built application', async () => {
    const policy = await call('/ui-model.js', { headers: { host: 'kidcontrol.test' } });
    expect(policy.status).toBe(200);
    expect(policy.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await policy.text()).toContain('export function canStart');

    const localization = await call('/i18n.js', { headers: { host: 'kidcontrol.test' } });
    expect(localization.status).toBe(200);
    expect(localization.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await localization.text()).toContain('export function resolveLocale');

    const usageChart = await call('/usage-chart.js', { headers: { host: 'kidcontrol.test' } });
    expect(usageChart.status).toBe(200);
    expect(usageChart.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await usageChart.text()).toContain('export function usageChartModel');
  });

  it('serves browser and Apple icons without authentication and with explicit image types', async () => {
    for (const [path, contentType] of [
      ['/favicon.ico', 'image/x-icon'],
      ['/icon.png', 'image/png'],
      ['/apple-touch-icon.png', 'image/png']
    ]) {
      const response = await call(path, { headers: { host: 'kidcontrol.test' } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe(contentType);
      expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(0);
    }

    const document = await call('/', { headers: { host: 'kidcontrol.test' } });
    const html = await document.text();
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any">');
    expect(html).toContain('<link rel="icon" href="/icon.png" type="image/png" sizes="1254x1254">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">');
  });

  it('shows a visually neutral repository copyright link below the version tag', async () => {
    const document = await call('/', { headers: { host: 'kidcontrol.test' } });
    const html = await document.text();
    expect(html).toContain('<span id="version-tag"');
    expect(html).toContain('<a class="copyright-link" href="https://github.com/tseiman/KidControl">© by Tseiman \'26</a>');
    expect(html.indexOf('class="copyright-link"')).toBeGreaterThan(html.indexOf('id="version-tag"'));

    const stylesheet = await call('/styles.css', { headers: { host: 'kidcontrol.test' } });
    const css = await stylesheet.text();
    expect(css).toMatch(/\.copyright-link[^}]*color:\s*var\(--muted\)/s);
    expect(css).toMatch(/\.copyright-link[^}]*text-decoration:\s*none/s);
    expect(css).toMatch(/\.copyright-link:visited,\s*\.copyright-link:hover,\s*\.copyright-link:active\s*{[^}]*color:\s*var\(--muted\)[^}]*text-decoration:\s*none/s);
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

  it('returns seven-day usage history only to superusers for each regular user', async () => {
    store.db.prepare('INSERT INTO usage_sessions(id,user_id,device_id,day,started_at,accounted_at,ended_at,end_reason,seconds) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('history', 'kid', 'tv', '2026-07-30', 1, 3_601, 3_601, 'test', 3_600);
    store.db.prepare('INSERT INTO ledger(user_id,day,seconds,session_id,created_at) VALUES(?,?,?,?,?)')
      .run('kid', '2026-07-30', 3_600, 'history', 3_601);

    const root = await login('root', '9999');
    const adminStatus = await call('/api/status', { headers: { host: 'kidcontrol.test', cookie: root.cookie } });
    const adminBody = await adminStatus.json() as { users: Array<{ id: string; usageLast7Days: Array<{ day: string; seconds: number }> }> };
    expect(adminBody.users[0]?.usageLast7Days).toEqual([
      { day: '2026-07-25', seconds: 0 },
      { day: '2026-07-26', seconds: 0 },
      { day: '2026-07-27', seconds: 0 },
      { day: '2026-07-28', seconds: 0 },
      { day: '2026-07-29', seconds: 0 },
      { day: '2026-07-30', seconds: 3_600 },
      { day: '2026-07-31', seconds: 0 }
    ]);

    const kid = await login();
    const userStatus = await call('/api/status', { headers: { host: 'kidcontrol.test', cookie: kid.cookie } });
    expect(await userStatus.json()).not.toHaveProperty('users');
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
