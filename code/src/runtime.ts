import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';

export interface RuntimeSettings {
  configPath: string;
  dbPath: string;
  appleCredentialsPath: string;
  unifiHost: string;
  unifiSiteId: string;
  unifiApiKey: string;
  unifiCaFile?: string;
  publicOrigin: string;
  trustedProxyIp: string;
  authPepper: Buffer;
  port: number;
  host: string;
  pollSeconds: number;
}

function canonicalHttps(name: string, value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (parsed.origin !== value || parsed.username || parsed.password) throw new Error(`${name} must be a canonical HTTPS origin`);
  return parsed.origin;
}
function absolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
function parsePepper(value: string): Buffer {
  let result: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) result = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9_-]{43}$/.test(value)) result = Buffer.from(value, 'base64url');
  else throw new Error('KIDCONTROL_AUTH_PEPPER must encode exactly 32 bytes as 64 hex or base64url');
  if (result.byteLength !== 32) throw new Error('KIDCONTROL_AUTH_PEPPER must encode exactly 32 bytes');
  return result;
}

export function runtimeSettings(env: Record<string, string | undefined>): RuntimeSettings {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const port = Number(env.PORT ?? '8080');
  const pollSeconds = Number(env.POLL_SECONDS ?? '5');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  if (!Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 300) throw new Error('POLL_SECONDS must be 1..300');
  const unifiCaFile = env.UNIFI_CA_FILE ? absolute('UNIFI_CA_FILE', env.UNIFI_CA_FILE) : undefined;
  const configPath = absolute('KIDCONTROL_CONFIG', required('KIDCONTROL_CONFIG'));
  const dbPath = absolute('KIDCONTROL_DB', required('KIDCONTROL_DB'));
  const appleCredentialsPath = absolute('APPLETV_CREDENTIALS', required('APPLETV_CREDENTIALS'));
  const trustedProxyIp = required('TRUSTED_PROXY_IP');
  if (!isIP(trustedProxyIp)) throw new Error('TRUSTED_PROXY_IP must be one IPv4 or IPv6 address');
  return {
    configPath,
    dbPath,
    appleCredentialsPath,
    unifiHost: canonicalHttps('UNIFI_HOST', required('UNIFI_HOST')),
    unifiSiteId: required('UNIFI_SITE_ID'),
    unifiApiKey: required('UNIFI_API_KEY'),
    ...(unifiCaFile ? { unifiCaFile } : {}),
    publicOrigin: canonicalHttps('PUBLIC_ORIGIN', required('PUBLIC_ORIGIN')),
    trustedProxyIp,
    authPepper: parsePepper(required('KIDCONTROL_AUTH_PEPPER')),
    port,
    host: env.HOST ?? '127.0.0.1',
    pollSeconds
  };
}
