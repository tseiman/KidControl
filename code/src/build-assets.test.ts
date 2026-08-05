import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSourceMappedDirectory, assertSourceMappedJavaScript, injectVersion } from '../scripts/build-helpers.mjs';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WebUI build metadata', () => {
  it('injects the exact build version into every WebUI placeholder', () => {
    const html = '<span data-version="__KIDCONTROL_VERSION__">Version __KIDCONTROL_VERSION__</span>';
    expect(injectVersion(html, 'abc1234-dirty')).toBe('<span data-version="abc1234-dirty">Version abc1234-dirty</span>');
  });

  it('fails the build when the WebUI version placeholder is missing', () => {
    expect(() => injectVersion('<html></html>', 'abc1234')).toThrow('version placeholder');
  });
});

describe('server source-map build guard', () => {
  const javascript = 'throw new Error("boom");\n//# sourceMappingURL=main.js.map\n';
  const completeMap = JSON.stringify({
    version: 3,
    file: 'main.js',
    sources: ['../src/main.ts'],
    sourcesContent: ['throw new Error("boom");'],
    mappings: 'AAAA'
  });

  it('accepts generated JavaScript with a matching map and embedded TypeScript source', () => {
    expect(() => assertSourceMappedJavaScript(javascript, completeMap, 'main.js')).not.toThrow();
  });

  it('rejects a generated map that omits its TypeScript source content', () => {
    const incompleteMap = JSON.stringify({
      version: 3,
      file: 'main.js',
      sources: ['../src/main.ts'],
      mappings: 'AAAA'
    });
    expect(() => assertSourceMappedJavaScript(javascript, incompleteMap, 'main.js')).toThrow('sourcesContent');
  });

  it('rejects maps with invalid source paths or missing mappings', () => {
    const invalidSources = JSON.stringify({
      version: 3,
      file: 'main.js',
      sources: [null],
      sourcesContent: ['source'],
      mappings: 'AAAA'
    });
    const missingMappings = JSON.stringify({
      version: 3,
      file: 'main.js',
      sources: ['../src/main.ts'],
      sourcesContent: ['source']
    });
    expect(() => assertSourceMappedJavaScript(javascript, invalidSources, 'main.js')).toThrow('source paths');
    expect(() => assertSourceMappedJavaScript(javascript, missingMappings, 'main.js')).toThrow('mappings');
  });

  it('recursively validates server maps and rejects orphan maps while excluding public assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kidcontrol-maps-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'nested'));
    await mkdir(join(directory, 'public'));
    await writeFile(join(directory, 'nested', 'worker.js'), 'export {};\n//# sourceMappingURL=worker.js.map\n');
    await writeFile(join(directory, 'nested', 'worker.js.map'), JSON.stringify({
      version: 3,
      file: 'worker.js',
      sources: ['../../src/nested/worker.ts'],
      sourcesContent: ['export {};'],
      mappings: 'AAAA'
    }));
    await writeFile(join(directory, 'public', 'app.js'), 'export {};\n');
    await expect(assertSourceMappedDirectory(directory)).resolves.toBeUndefined();
    await writeFile(join(directory, 'orphan.js.map'), '{}');
    await expect(assertSourceMappedDirectory(directory)).rejects.toThrow('orphan');
  });

  it('fails closed on symbolic links in the generated server tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kidcontrol-map-links-'));
    temporaryDirectories.push(directory);
    await symlink('missing.js', join(directory, 'linked.js'));
    await expect(assertSourceMappedDirectory(directory)).rejects.toThrow('symbolic link');
  });
});
