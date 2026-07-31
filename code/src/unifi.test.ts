import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { request as HttpsRequest } from 'node:https';
import { UniFiAclController, nativeHttpsFetch } from './unifi.js';

const rule = {
  id: 'rule/1', type: 'IPV4', name: 'KC TV', description: 'managed', action: 'BLOCK',
  networkIdFilter: ['n'], sourceFilter: { type: 'IP_ADDRESS', value: 'x' }, destinationFilter: null,
  enforcingDeviceFilter: null, enabled: true, dangerous: 'must-not-send'
};
const client = (fetcher: typeof fetch, options = {}) => new UniFiAclController(
  'https://console.example', 'site id', 'secret', [{ id: 'tv', aclRuleName: 'KC TV' }], fetcher, options
);

describe('hardened UniFi integration', () => {
  it('requires HTTPS and a strict exact rule shape', async () => {
    expect(() => new UniFiAclController('http://console', 's', 'k', [], fetch)).toThrow('HTTPS');
    const malformed = vi.fn(async () => new Response(JSON.stringify({ data: [{ ...rule, enabled: 'false' }] }), { status: 200 }));
    await expect(client(malformed).read('tv')).rejects.toThrow('invalid UniFi ACL rule');
  });

  it('GETs exact rule, PUTs only allowlisted fields with encoded id, and verifies readback', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [rule] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...rule, enabled: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...rule, enabled: false } }), { status: 200 }));
    await client(fetcher).setBlocked('tv', false);
    expect(fetcher.mock.calls[1]![0]).toContain('/acl-rules/rule%2F1');
    const payload = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(payload.dangerous).toBeUndefined();
    expect(payload.enabled).toBe(false);
    expect(fetcher.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('disambiguates a thrown PUT with exactly one GET and accepts confirmed success', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [rule] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...rule, enabled: false } }), { status: 200 }));
    await expect(client(fetcher).setBlocked('tv', false)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds response bytes and aborts hanging requests', async () => {
    const oversized = vi.fn(async () => new Response(JSON.stringify({ data: 'x'.repeat(200) }), { status: 200 }));
    await expect(client(oversized, { maxResponseBytes: 100 }).read('tv')).rejects.toThrow('too large');
    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(client(hanging, { timeoutMs: 10 }).read('tv')).rejects.toThrow('timed out');
  });

  it('destroys an oversized custom-CA response while native HTTPS is still streaming', async () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      destroy: vi.fn()
    });
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn()
    });
    const requester = vi.fn((_url, _options, callback) => {
      queueMicrotask(() => {
        callback(response);
        response.emit('data', Buffer.alloc(8));
      });
      return request;
    }) as unknown as typeof HttpsRequest;
    const customCaFetch = nativeHttpsFetch('dummy CA', 4, requester);
    await expect(customCaFetch('https://console.example/test')).rejects.toThrow('too large');
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(request.destroy).toHaveBeenCalledOnce();
  });
});
