import { once } from 'node:events';
import type { Server } from 'node:http';

export interface StartupResources {
  core: { recover(): Promise<void>; close(): Promise<void> };
  monitor: { start(): Promise<void>; close(): Promise<void> };
  server: Server;
  store: { close(): void };
}

export async function startResources(
  resources: StartupResources,
  port: number,
  host: string
): Promise<void> {
  try {
    await resources.core.recover();
    await resources.monitor.start();
    const listening = once(resources.server, 'listening');
    resources.server.listen(port, host);
    await listening;
  } catch (error) {
    if (resources.server.listening) {
      await new Promise<void>((resolve) => resources.server.close(() => resolve()));
    }
    await Promise.allSettled([
      resources.monitor.close(),
      resources.core.close()
    ]);
    resources.store.close();
    throw error;
  }
}
