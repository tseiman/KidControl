import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UserConfig } from './domain.js';
import { Store } from './store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeUser = (value: string) => value.trim().toLowerCase();
const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super('invalid credentials'); this.name = 'RateLimitError'; }
}

export class Auth {
  private readonly pepper: Buffer;
  constructor(
    private readonly store: Store,
    private readonly users: () => UserConfig[],
    pepper: Buffer,
    private readonly clock: () => number = Date.now
  ) {
    if (pepper.byteLength !== 32) throw new Error('KIDCONTROL_AUTH_PEPPER must decode to exactly 32-byte');
    this.pepper = Buffer.from(pepper);
  }

  private fingerprint(user: UserConfig): string {
    return createHmac('sha256', this.pepper).update(`${user.id}\0${user.pin}\0${user.role}`).digest('hex');
  }

  private rateLimit(dimension: 'source' | 'user', key: string, now: number): number | undefined {
    const windowStart = now - 15 * 60 * 1000;
    const row = this.store.db.prepare(`SELECT COUNT(*) count,MIN(attempted_at) oldest FROM auth_attempts
      WHERE dimension=? AND key=? AND attempted_at>=?`).get(dimension, key, windowStart) as { count: number | bigint; oldest: number | null };
    if (Number(row.count) < 5 || row.oldest === null) return undefined;
    return Math.max(1, Math.ceil((row.oldest + 15 * 60 * 1000 - now) / 1000));
  }

  login(userId: string, pin: string, source: string): { token: string; csrf: string; user: UserConfig } {
    const now = this.clock();
    const normalized = normalizeUser(userId);
    this.store.db.prepare('DELETE FROM auth_attempts WHERE attempted_at<?').run(now - 15 * 60 * 1000);
    const sourceRetry = this.rateLimit('source', source, now);
    const userRetry = this.rateLimit('user', normalized, now);
    if (sourceRetry || userRetry) throw new RateLimitError(Math.max(sourceRetry ?? 0, userRetry ?? 0));
    const user = this.users().find((candidate) => normalizeUser(candidate.id) === normalized);
    const supplied = Buffer.from(pin.padEnd(4, '\0'));
    const expected = Buffer.from((user?.pin ?? '0000').padEnd(4, '\0'));
    if (!user || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      this.store.transaction(() => {
        this.store.db.prepare('INSERT INTO auth_attempts(dimension,key,attempted_at) VALUES(?,?,?)').run('source', source, now);
        this.store.db.prepare('INSERT INTO auth_attempts(dimension,key,attempted_at) VALUES(?,?,?)').run('user', normalized, now);
      });
      throw new Error('invalid credentials');
    }
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    this.store.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,auth_fingerprint,csrf,created_at) VALUES(?,?,?,?,?)').run(hash(token), user.id, this.fingerprint(user), csrf, now);
    return { token, csrf, user };
  }

  authenticate(token: string | undefined): UserConfig | undefined {
    if (!token) return undefined;
    const tokenHash = hash(token);
    const row = this.store.db.prepare('SELECT user_id userId,auth_fingerprint fingerprint FROM auth_sessions WHERE token_hash=?').get(tokenHash) as { userId: string; fingerprint: string } | undefined;
    if (!row) return undefined;
    const user = this.users().find((candidate) => candidate.id === row.userId);
    if (!user || !safeEqual(this.fingerprint(user), row.fingerprint)) {
      this.store.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash);
      return undefined;
    }
    return user;
  }

  bootstrap(token: string | undefined): { user: UserConfig; csrf: string } | undefined {
    const user = this.authenticate(token);
    if (!user || !token) return undefined;
    const csrf = randomBytes(32).toString('base64url');
    this.store.db.prepare('UPDATE auth_sessions SET csrf=? WHERE token_hash=?').run(csrf, hash(token));
    return { user, csrf };
  }

  verifyCsrf(token: string | undefined, value: string | undefined): boolean {
    if (!token || !value) return false;
    const row = this.store.db.prepare('SELECT csrf FROM auth_sessions WHERE token_hash=?').get(hash(token)) as { csrf: string } | undefined;
    return Boolean(row && safeEqual(row.csrf, value));
  }
  logout(token: string | undefined): void {
    if (token) this.store.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));
  }
}
