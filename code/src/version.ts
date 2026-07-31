import { readFileSync } from 'node:fs';

export function buildVersion(moduleUrl: string | URL = import.meta.url): string {
  try {
    const version = readFileSync(new URL('./version.txt', moduleUrl), 'utf8').trim();
    return /^[0-9a-f]{7,40}(?:-dirty)?$/.test(version) ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function versionBanner(version: string = buildVersion()): string {
  return `KidControl version ${version}`;
}
