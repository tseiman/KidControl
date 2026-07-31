import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { Auth, RateLimitError } from './auth.js';
import type { UserConfig } from './domain.js';

const original: UserConfig[] = [
  { id: 'kid', displayName: 'Kid', pin: '1234', role: 'user', weeklyBudgetMinutes: { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1 } },
  { id: 'root', displayName: 'Root', pin: '9999', role: 'superuser' }
];
const pepper = Buffer.alloc(32, 7);

describe('authentication security', () => {
  let users: UserConfig[]; let store: Store; let now: number; let auth: Auth;
  beforeEach(() => { users = structuredClone(original); store = new Store(':memory:'); now = 1_000_000; auth = new Auth(store, () => users, pepper, () => now); });
  afterEach(() => store.close());

  it('requires an independent 32-byte pepper and stores only token SHA256 plus keyed fingerprint', () => {
    expect(() => new Auth(store, () => users, Buffer.alloc(31))).toThrow('32-byte');
    const result = auth.login('kid', '1234', 'source-a');
    const row = store.db.prepare('SELECT token_hash tokenHash,auth_fingerprint fingerprint FROM auth_sessions').get() as { tokenHash: string; fingerprint: string };
    expect(row.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(row.tokenHash).not.toContain(result.token);
    expect(row.fingerprint).not.toBe(createHash('sha256').update('kid\x001234\x00user').digest('hex'));
  });

  it('revokes sessions on PIN, role, or removal and rotates CSRF on bootstrap', () => {
    const result = auth.login('kid', '1234', 'source');
    const boot = auth.bootstrap(result.token);
    expect(boot?.csrf).not.toBe(result.csrf);
    users[0]!.role = 'superuser';
    expect(auth.authenticate(result.token)).toBeUndefined();
  });

  it('rate limits independently by source and normalized user with a typed retry result', () => {
    for (let index = 0; index < 5; index++) expect(() => auth.login(' KID ', '0000', `source-${index}`)).toThrow('invalid credentials');
    try { auth.login('kid', '1234', 'fresh-source'); throw new Error('expected limit'); }
    catch (error) { expect(error).toBeInstanceOf(RateLimitError); expect((error as RateLimitError).retryAfterSeconds).toBe(900); }
    now += 900_001;
    for (let index = 0; index < 5; index++) expect(() => auth.login(`missing-${index}`, '0000', 'shared-source')).toThrow('invalid credentials');
    expect(() => auth.login('root', '9999', 'shared-source')).toThrow(RateLimitError);
  });
});
