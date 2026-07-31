import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { validateConfig } from './domain.js';
import { runtimeSettings } from './runtime.js';
import { Store } from './store.js';
import { UniFiAclController } from './unifi.js';
import { KidControl } from './kid-control.js';
import { Auth } from './auth.js';
import { AppleTvMonitor } from './apple-tv.js';
import { createKidControlServer } from './server.js';
import { startResources } from './startup.js';

function protectedFile(path: string, label: string): string {
  const status = statSync(path);
  if (!status.isFile() || (status.mode & 0o077) !== 0) throw new Error(`${label} must be a regular file with mode 0600`);
  if (typeof process.geteuid === 'function' && status.uid !== process.geteuid()) throw new Error(`${label} must be owned by the service user`);
  return readFileSync(path, 'utf8');
}
function safeStateDirectory(path: string): void {
  const status = statSync(dirname(path));
  if (!status.isDirectory() || (status.mode & 0o077) !== 0) throw new Error('KIDCONTROL_DB parent directory must not be accessible by group or others');
}

async function main(): Promise<void> {
  process.umask(0o077);
  const settings = runtimeSettings(process.env);
  const config = validateConfig(JSON.parse(protectedFile(settings.configPath, 'KIDCONTROL_CONFIG')));
  const credentialText = protectedFile(settings.appleCredentialsPath, 'APPLETV_CREDENTIALS');
  safeStateDirectory(settings.dbPath);
  const ca = settings.unifiCaFile ? protectedFile(settings.unifiCaFile, 'UNIFI_CA_FILE') : undefined;
  const store = new Store(settings.dbPath);
  const unifi = new UniFiAclController(settings.unifiHost, settings.unifiSiteId, settings.unifiApiKey, config.devices, fetch, ca ? { ca } : {});
  const core = new KidControl(config, store, unifi);
  const auth = new Auth(store, () => config.users, settings.authPepper);
  const documentation = readFileSync(new URL('./documentation.md', import.meta.url), 'utf8');
  const monitor = AppleTvMonitor.production(config.devices, credentialText, (device, state) => core.powerChanged(device, state));

  const server = createKidControlServer(config, core, auth, {
    publicDir: new URL('./public/', import.meta.url), documentation, publicOrigin: settings.publicOrigin,
    trustedProxyIp: settings.trustedProxyIp
  });
  await startResources({ core, monitor, server, store }, settings.port, settings.host);
  console.log(`KidControl listening on ${settings.host}:${settings.port}`);

  const poll = setInterval(() => {
    void core.poll().catch((error) => console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown error'));
  }, settings.pollSeconds * 1000);
  poll.unref();

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    void (async () => {
      console.log('KidControl shutting down');
      const serverClosed = once(server, 'close');
      server.close();
      await Promise.all([serverClosed, monitor.close(), core.close()]);
      store.close();
    })().catch((error) => {
      console.error('shutdown failed', error instanceof Error ? error.message : 'unknown error');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('KidControl startup failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
