import { cp, mkdir, rm } from 'node:fs/promises';

await rm(new URL('../dist/public/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await cp(new URL('../public/', import.meta.url), new URL('../dist/public/', import.meta.url), { recursive: true });
await cp(new URL('../../docs/README_KIDCONTROL.md', import.meta.url), new URL('../dist/documentation.md', import.meta.url));
