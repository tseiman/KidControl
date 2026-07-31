import { describe, expect, it } from 'vitest';
import { runtimeSettings } from './runtime.js';

const safe = {
  KIDCONTROL_CONFIG: '/etc/kidcontrol/config.json', KIDCONTROL_DB: '/var/lib/kidcontrol/state.sqlite',
  APPLETV_CREDENTIALS: '/etc/kidcontrol/apple-tv.json', UNIFI_HOST: 'https://unifi.example',
  UNIFI_SITE_ID: 'site', UNIFI_API_KEY: 'dummy-key', PUBLIC_ORIGIN: 'https://kidcontrol.example',
  TRUSTED_PROXY_IP: '127.0.0.1',
  KIDCONTROL_AUTH_PEPPER: '11'.repeat(32)
};
describe('strict runtime environment', () => {
  it('requires public origin and auth pepper', () => {
    expect(() => runtimeSettings({})).toThrow('KIDCONTROL_CONFIG');
    expect(() => runtimeSettings({ ...safe, PUBLIC_ORIGIN: undefined })).toThrow('PUBLIC_ORIGIN');
    expect(() => runtimeSettings({ ...safe, KIDCONTROL_AUTH_PEPPER: 'short' })).toThrow('32 bytes');
  });
  it('accepts only canonical HTTPS origins, absolute paths, and bounded values', () => {
    expect(runtimeSettings(safe)).toMatchObject({ publicOrigin: 'https://kidcontrol.example', pollSeconds: 5 });
    expect(() => runtimeSettings({ ...safe, UNIFI_HOST: 'http://x' })).toThrow('HTTPS');
    expect(() => runtimeSettings({ ...safe, PUBLIC_ORIGIN: 'https://x/path' })).toThrow('canonical');
    expect(() => runtimeSettings({ ...safe, KIDCONTROL_DB: 'relative.sqlite' })).toThrow('absolute');
    expect(() => runtimeSettings({ ...safe, TRUSTED_PROXY_IP: 'proxy.example' })).toThrow('IPv4 or IPv6');
  });
  it('has no insecure transport or cookie downgrade switches', () => {
    const result = runtimeSettings({ ...safe, UNIFI_ALLOW_INSECURE: 'true', COOKIE_SECURE: 'false', UNIFI_CA_FILE: '/etc/kidcontrol/ca.pem' });
    expect(result.unifiCaFile).toBe('/etc/kidcontrol/ca.pem');
    expect(result).not.toHaveProperty('cookieSecure');
  });
});
