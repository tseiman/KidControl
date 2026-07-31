import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVersion, versionBanner } from './version.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('build version', () => {
  it('formats the short embedded Git revision for the startup journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-version-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'version.txt'), '27b6a88\n', 'utf8');

    expect(buildVersion(pathToFileURL(join(directory, 'version.js')))).toBe('27b6a88');
    expect(versionBanner('27b6a88')).toBe('KidControl version 27b6a88');
  });

  it('reports an unknown version when the build artifact is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-version-'));
    temporary.push(directory);

    expect(buildVersion(pathToFileURL(join(directory, 'version.js')))).toBe('unknown');
  });
});
