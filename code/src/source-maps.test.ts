import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const tsconfig = JSON.parse(readFileSync(new URL('code/tsconfig.json', root), 'utf8')) as {
  compilerOptions: Record<string, unknown>;
};
const packageJson = JSON.parse(readFileSync(new URL('code/package.json', root), 'utf8')) as {
  scripts: Record<string, string>;
};
const unit = readFileSync(new URL('etc/kidcontrol.service', root), 'utf8');
const assetBuilder = readFileSync(new URL('code/scripts/build-assets.mjs', root), 'utf8');

describe('production source maps', () => {
  it('generates external maps containing the TypeScript sources', () => {
    expect(tsconfig.compilerOptions.sourceMap).toBe(true);
    expect(tsconfig.compilerOptions.inlineSources).toBe(true);
    expect(tsconfig.compilerOptions.inlineSourceMap).not.toBe(true);
  });

  it('enables Node source-map stack traces for both supported production start paths', () => {
    expect(packageJson.scripts.start).toBe('node --enable-source-maps dist/main.js');
    expect(unit).toContain('ExecStart=/usr/bin/env node --enable-source-maps /opt/kidcontrol/code/dist/main.js');
  });

  it('runs an end-to-end mapped-stack verification after generating build assets', () => {
    expect(packageJson.scripts.build).toBe('node scripts/clean-dist.mjs && tsc && node scripts/build-assets.mjs && node scripts/verify-source-maps.mjs');
    expect(assetBuilder).toContain("new URL('../dist/build-helpers.mjs', import.meta.url)");
    expect(assetBuilder).toContain("new URL('../dist/verify-source-maps.mjs', import.meta.url)");
  });
});
