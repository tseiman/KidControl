import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

describe('daily reset persistence', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('migrates an existing database to the 00:00 default without a retroactive due occurrence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-reset-'));
    directories.push(directory);
    const path = join(directory, 'legacy.sqlite');
    const legacy = new Store(path);
    legacy.db.exec('DROP TABLE daily_reset');
    legacy.close();

    const migrated = new Store(path);
    expect(migrated.dailyReset()).toEqual({ time: '00:00', nextResetAt: null });
    migrated.close();
  });

  it('persists the configured time and next occurrence across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-reset-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const first = new Store(path);
    first.setDailyReset('14:35', 1_800_000_000);
    first.close();

    const second = new Store(path);
    expect(second.dailyReset()).toEqual({ time: '14:35', nextResetAt: 1_800_000_000 });
    second.close();
  });
});
