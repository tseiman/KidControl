import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const scriptUrl = new URL('../../unlock-login.sh', import.meta.url);
const script = readFileSync(scriptUrl, 'utf8');
const temporaryDirectories: string[] = [];

function runEmbeddedUnlock(databasePath: string) {
  const match = script.match(/<<'NODE'\n([\s\S]*?)\nNODE/);
  expect(match).not.toBeNull();
  return spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-', databasePath], {
    input: match![1],
    encoding: 'utf8',
    env: { ...process.env, KIDCONTROL_DB: databasePath, NODE_NO_WARNINGS: '1' }
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('login unlock administrator script', () => {
  it('deletes every login throttle record and preserves sessions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-unlock-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY CHECK(version = 1));
      INSERT INTO schema_version VALUES(1);
      CREATE TABLE auth_attempts(dimension TEXT NOT NULL, key TEXT NOT NULL, attempted_at INTEGER NOT NULL);
      CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      INSERT INTO auth_attempts VALUES('source','192.0.2.1',1),('user','anna',2),('user','florian',3);
      INSERT INTO auth_sessions VALUES('token','anna');
    `);
    db.close();

    const result = runEmbeddedUnlock(path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Removed 3 login throttle record(s); 0 remain.');

    const checked = new DatabaseSync(path, { readOnly: true });
    expect(checked.prepare('SELECT COUNT(*) count FROM auth_attempts').get()).toEqual({ count: 0 });
    expect(checked.prepare('SELECT COUNT(*) count FROM auth_sessions').get()).toEqual({ count: 1 });
    checked.close();
  });

  it('refuses to delete records when auth_attempts has a trigger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kidcontrol-unlock-trigger-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY CHECK(version = 1));
      INSERT INTO schema_version VALUES(1);
      CREATE TABLE auth_attempts(dimension TEXT NOT NULL, key TEXT NOT NULL, attempted_at INTEGER NOT NULL);
      CREATE TABLE touched(value INTEGER NOT NULL);
      CREATE TRIGGER unexpected AFTER DELETE ON auth_attempts BEGIN INSERT INTO touched VALUES(1); END;
      INSERT INTO auth_attempts VALUES('source','192.0.2.1',1);
    `);
    db.close();

    const result = runEmbeddedUnlock(path);
    expect(result.status).not.toBe(0);

    const checked = new DatabaseSync(path, { readOnly: true });
    expect(checked.prepare('SELECT COUNT(*) count FROM auth_attempts').get()).toEqual({ count: 1 });
    expect(checked.prepare('SELECT COUNT(*) count FROM touched').get()).toEqual({ count: 0 });
    checked.close();
  });

  it('provides an executable root-only wrapper around the canonical production database', () => {
    expect(statSync(scriptUrl).mode & 0o111).not.toBe(0);
    expect(spawnSync('bash', ['-n', scriptUrl.pathname], { encoding: 'utf8' }).status).toBe(0);
    const help = spawnSync(scriptUrl.pathname, ['--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: sudo ./unlock-login.sh');
    expect(script).toContain('EUID != 0');
    expect(script).toContain('DATABASE_PATH="/var/lib/kidcontrol/state.sqlite"');
    expect(script).toContain('realpath --canonicalize-existing');
    expect(script).toContain('SERVICE_USER" == kidcontrol');
    expect(script).toContain('runuser --user "$SERVICE_USER"');
    expect(script).toContain('PRAGMA busy_timeout=5000');
    expect(script).toContain('DELETE FROM auth_attempts');
  });
});
