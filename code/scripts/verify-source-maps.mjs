import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSourceMappedDirectory } from './build-helpers.mjs';

const dist = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}${sep}`)
  : new URL('../dist/', import.meta.url);

await assertSourceMappedDirectory(dist);

const domainModule = new URL('domain.js', dist).href;
const probe = `import { validateConfig } from ${JSON.stringify(domainModule)}; validateConfig(null);`;
const result = spawnSync(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval', probe], {
  encoding: 'utf8'
});

if (result.status === 0) throw new Error('Source-map probe unexpectedly succeeded');
if (!result.stderr.includes('/src/domain.ts:')) {
  throw new Error(`Source-map probe did not map its stack to TypeScript:\n${result.stderr}`);
}
