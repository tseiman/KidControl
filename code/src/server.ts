import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { Config } from './domain.js';
import type { KidControl } from './kid-control.js';
import { RateLimitError, type Auth } from './auth.js';
import { logOperationalError, logOperationalInfo } from './operational-log.js';

interface Options { publicDir: string | URL; iconDir: string; documentation: string; publicOrigin: string; trustedProxyIp: string; bodyLimitBytes?: number }
const COOKIE = '__Host-kidcontrol';
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function markdown(source: string): string {
  return source.split('\n').map((line) => {
    if (line.startsWith('# ')) return `<h1>${escape(line.slice(2))}</h1>`;
    if (line.startsWith('## ')) return `<h2>${escape(line.slice(3))}</h2>`;
    if (line.startsWith('### ')) return `<h3>${escape(line.slice(4))}</h3>`;
    return line.trim() ? `<p>${escape(line)}</p>` : '';
  }).join('\n');
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((part) => part.trim().split('=', 2)).find(([key]) => key === name)?.[1];
}
async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error('invalid JSON body'); }
}
function send(res: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}): void {
  for (const [key, item] of Object.entries({ ...securityHeaders, ...headers })) res.setHeader(key, item);
  res.statusCode = status;
  if (value === undefined) { res.end(); return; }
  res.setHeader('Content-Type', typeof value === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}
const iconUrl = (user: Config['users'][number]) => user.icon ? `/api/user-icons/${encodeURIComponent(user.id)}` : undefined;
const userView = (user: Config['users'][number]) => ({ id: user.id, displayName: user.displayName, role: user.role, ...(user.icon ? { iconUrl: iconUrl(user) } : {}) });
const normalizedIp = (value: string) => value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
function clientSource(req: IncomingMessage, trustedProxyIp: string): string {
  const socketAddress = normalizedIp(req.socket.remoteAddress ?? '');
  if (socketAddress !== normalizedIp(trustedProxyIp)) return socketAddress || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.includes(',') || !isIP(forwarded.trim())) {
    throw new Error('invalid forwarded client address');
  }
  return normalizedIp(forwarded.trim());
}

export function createKidControlServer(config: Config, core: KidControl, auth: Auth, options: Options) {
  const publicOrigin = new URL(options.publicOrigin);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== options.publicOrigin) throw new Error('PUBLIC_ORIGIN must be a canonical HTTPS origin');
  const allowedHost = publicOrigin.host;
  const publicDir = typeof options.publicDir === 'string' ? options.publicDir : fileURLToPath(options.publicDir);
  const bodyLimit = options.bodyLimitBytes ?? 16_384;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== allowedHost) return send(res, 400, { error: 'invalid host' }, { 'Cache-Control': 'no-store' });
      const method = req.method ?? 'GET';
      if (method === 'POST' && req.headers.origin !== options.publicOrigin) return send(res, 403, { error: 'invalid origin' }, { 'Cache-Control': 'no-store' });
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (method === 'POST' && (!Number.isFinite(contentLength) || contentLength > bodyLimit)) {
        req.resume(); return send(res, 413, { error: 'request body too large' }, { 'Cache-Control': 'no-store' });
      }
      const url = new URL(req.url ?? '/', options.publicOrigin);
      if (method === 'GET' && url.pathname === '/health') {
        const degraded = core.deviceStatuses().some((device) => device.power === 'unknown' || device.acl === 'unknown' || device.acl === 'degraded');
        return send(res, 200, { status: degraded ? 'degraded' : 'ok' }, { 'Cache-Control': 'no-store' });
      }
      if (method === 'GET' && url.pathname === '/api/public') {
        return send(res, 200, { users: config.users.map((user) => ({ id: user.id, displayName: user.displayName, ...(user.icon ? { iconUrl: iconUrl(user) } : {}) })) }, { 'Cache-Control': 'no-store' });
      }
      if (method === 'GET' && url.pathname.startsWith('/api/user-icons/')) {
        const user = config.users.find((candidate) => iconUrl(candidate) === url.pathname);
        if (!user?.icon) return send(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
        try {
          const path = join(options.iconDir, user.icon);
          const status = lstatSync(path);
          if (!status.isFile() || status.size > 5 * 1024 * 1024) return send(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
          const extension = user.icon.toLowerCase().split('.').pop();
          const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
          for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
          res.setHeader('Content-Type', types[extension!]!);
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(readFileSync(path));
          return;
        } catch {
          return send(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
        }
      }
      if (method === 'POST' && url.pathname === '/api/login') {
        const input = await body(req, bodyLimit);
        const clientIp = clientSource(req, options.trustedProxyIp);
        const result = auth.login(String(input.userId ?? ''), String(input.pin ?? ''), clientIp);
        logOperationalInfo('login', { userId: result.user.id, userName: result.user.displayName, clientIp });
        return send(res, 200, { csrf: result.csrf, user: userView(result.user) }, {
          'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=315360000`
        });
      }
      if (method === 'GET' && url.pathname === '/docs') {
        return send(res, 200, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><title>KidControl documentation</title><main class="docs">${markdown(options.documentation)}</main></html>`);
      }
      if (method === 'GET' && ['/', '/index.html', '/app.js', '/ui-model.js', '/i18n.js', '/usage-chart.js', '/styles.css', '/favicon.ico', '/icon.png', '/apple-touch-icon.png'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const types: Record<string, string> = {
          'index.html': 'text/html; charset=utf-8',
          'app.js': 'text/javascript; charset=utf-8',
          'ui-model.js': 'text/javascript; charset=utf-8',
          'i18n.js': 'text/javascript; charset=utf-8',
          'usage-chart.js': 'text/javascript; charset=utf-8',
          'styles.css': 'text/css; charset=utf-8',
          'favicon.ico': 'image/x-icon',
          'icon.png': 'image/png',
          'apple-touch-icon.png': 'image/png'
        };
        const content = readFileSync(join(publicDir, name));
        for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
        res.setHeader('Content-Type', types[name]!); res.end(content); return;
      }
      const token = cookie(req, COOKIE);
      if (method === 'GET' && url.pathname === '/api/session') {
        const session = auth.bootstrap(token);
        if (!session) return send(res, 401, { error: 'authentication required' }, { 'Cache-Control': 'no-store' });
        return send(res, 200, { user: userView(session.user), csrf: session.csrf }, { 'Cache-Control': 'no-store' });
      }
      const user = auth.authenticate(token);
      if (!user) return send(res, 401, { error: 'authentication required' }, { 'Cache-Control': 'no-store' });
      if (method === 'GET' && url.pathname === '/api/status') {
        const state = core.status(user.id);
        return send(res, 200, {
          me: userView(user), remainingSeconds: state.remainingSeconds, unlimited: state.unlimited,
          activeDeviceId: state.activeDeviceId, devices: core.deviceStatuses(),
          ...(user.role === 'superuser' ? { users: config.users.filter((item) => item.role === 'user').map((item) => ({
            id: item.id,
            displayName: item.displayName,
            ...(item.icon ? { iconUrl: iconUrl(item) } : {}),
            remainingSeconds: core.status(item.id).remainingSeconds,
            usageLast7Days: core.usageHistory(item.id)
          })) } : {})
        }, { 'Cache-Control': 'no-store' });
      }
      if (method !== 'POST') return send(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
      if (!auth.verifyCsrf(token, req.headers['x-csrf-token'] as string | undefined)) return send(res, 403, { error: 'invalid CSRF token' }, { 'Cache-Control': 'no-store' });
      if (url.pathname === '/api/logout') {
        auth.logout(token);
        return send(res, 204, undefined, { 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      }
      const input = await body(req, bodyLimit);
      if (url.pathname === '/api/claim') { await core.start(user.id, String(input.deviceId ?? '')); return send(res, 204, undefined, { 'Cache-Control': 'no-store' }); }
      if (url.pathname === '/api/stop') { await core.stop(user.id); return send(res, 204, undefined, { 'Cache-Control': 'no-store' }); }
      if (url.pathname === '/api/admin/adjust') {
        if (user.role !== 'superuser') return send(res, 403, { error: 'superuser required' }, { 'Cache-Control': 'no-store' });
        await core.setRemaining(user.id, String(input.userId ?? ''), Number(input.remainingSeconds));
        return send(res, 204, undefined, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/api/admin/restore') {
        if (user.role !== 'superuser') return send(res, 403, { error: 'superuser required' }, { 'Cache-Control': 'no-store' });
        await core.restore(user.id); return send(res, 204, undefined, { 'Cache-Control': 'no-store' });
      }
      return send(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      if (error instanceof RateLimitError) return send(res, 429, { error: 'invalid credentials' }, { 'Cache-Control': 'no-store', 'Retry-After': String(error.retryAfterSeconds) });
      const message = error instanceof Error ? error.message : 'request failed';
      if (message === 'invalid credentials') return send(res, 401, { error: 'invalid credentials' }, { 'Cache-Control': 'no-store' });
      const authorizationError = /reserved by superuser|superuser required/.test(message);
      const clientError = /unknown|invalid|exhausted|required|00:00|too large/.test(message);
      const powerConflict = message === 'Apple TV is not on';
      if (!clientError && !authorizationError && !powerConflict) logOperationalError('request-error', { method: req.method ?? 'GET', path: req.url ?? '/', message });
      const status = authorizationError ? 403 : powerConflict ? 409 : clientError ? (message.includes('too large') ? 413 : 400) : 500;
      send(res, status, { error: clientError || authorizationError || powerConflict ? message : 'internal server error' }, { 'Cache-Control': 'no-store' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
