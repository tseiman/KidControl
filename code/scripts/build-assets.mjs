import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { assertSourceMappedDirectory, injectVersion } from './build-helpers.mjs';

const repository = new URL('../../', import.meta.url);
const revision = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8'
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: repository,
  encoding: 'utf8'
}).trim().length > 0;
const version = `${revision}${dirty ? '-dirty' : ''}`;

await rm(new URL('../dist/public/', import.meta.url), { recursive: true, force: true });
const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await assertSourceMappedDirectory(dist);
await cp(new URL('../public/', import.meta.url), new URL('../dist/public/', import.meta.url), { recursive: true });
const builtIndex = new URL('../dist/public/index.html', import.meta.url);
await writeFile(builtIndex, injectVersion(await readFile(builtIndex, 'utf8'), version), { mode: 0o644 });
await cp(new URL('../../docs/README_KIDCONTROL.md', import.meta.url), new URL('../dist/documentation.md', import.meta.url));
await cp(new URL('./build-helpers.mjs', import.meta.url), new URL('../dist/build-helpers.mjs', import.meta.url));
await cp(new URL('./verify-source-maps.mjs', import.meta.url), new URL('../dist/verify-source-maps.mjs', import.meta.url));
await writeFile(new URL('../dist/version.txt', import.meta.url), `${version}\n`, { mode: 0o644 });
