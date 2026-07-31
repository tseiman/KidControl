import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startResources } from './startup.js';

describe('staged startup cleanup', () => {
  const occupied = createServer();
  afterEach(async () => {
    if (occupied.listening) {
      occupied.close();
      await once(occupied, 'close');
    }
  });

  it('closes every started resource when listen fails', async () => {
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const address = occupied.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const server = createServer();
    const core = { recover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const monitor = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const store = { close: vi.fn() };

    await expect(startResources({ server, core, monitor, store }, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(core.close).toHaveBeenCalledOnce();
    expect(monitor.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });
});
