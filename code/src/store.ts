import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface Claim {
  userId: string;
  deviceId: string;
  sessionId: string;
  startedAt: number;
  accountedAt: number;
}

export interface AclState {
  deviceId: string;
  desiredBlocked: boolean;
  actualBlocked: boolean | null;
  baselineBlocked: boolean;
  source: 'baseline' | 'external' | 'kidcontrol' | 'pending';
  pending: boolean;
  attempts: number;
  lastError: string | null;
  nextRetryAt: number | null;
  updatedAt: number;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly path: string;

  constructor(path: string) {
    process.umask(0o077);
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.migrate();
    this.secureFiles();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY CHECK(version = 1));
      INSERT OR IGNORE INTO schema_version(version) VALUES(1);
      CREATE TABLE IF NOT EXISTS usage_sessions(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        day TEXT NOT NULL CHECK(length(day)=10), started_at INTEGER NOT NULL CHECK(started_at>=0),
        accounted_at INTEGER NOT NULL CHECK(accounted_at>=started_at), ended_at INTEGER,
        end_reason TEXT, seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds>=0)
      );
      CREATE TABLE IF NOT EXISTS claims(
        user_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE
          REFERENCES usage_sessions(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL CHECK(started_at>=0), accounted_at INTEGER NOT NULL CHECK(accounted_at>=started_at)
      );
      CREATE TABLE IF NOT EXISTS ledger(
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL CHECK(length(day)=10),
        seconds INTEGER NOT NULL CHECK(seconds>0), session_id TEXT NOT NULL REFERENCES usage_sessions(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adjustments(
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL CHECK(length(day)=10),
        seconds INTEGER NOT NULL, author_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions(
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64), user_id TEXT NOT NULL,
        auth_fingerprint TEXT NOT NULL CHECK(length(auth_fingerprint)=64), csrf TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_attempts(
        dimension TEXT NOT NULL CHECK(dimension IN ('source','user')), key TEXT NOT NULL, attempted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_attempts_lookup ON auth_attempts(dimension,key,attempted_at);
      CREATE TABLE IF NOT EXISTS acl_state(
        device_id TEXT PRIMARY KEY, desired_blocked INTEGER NOT NULL CHECK(desired_blocked IN (0,1)),
        actual_blocked INTEGER CHECK(actual_blocked IN (0,1)), baseline_blocked INTEGER NOT NULL CHECK(baseline_blocked IN (0,1)),
        source TEXT NOT NULL CHECK(source IN ('baseline','external','kidcontrol','pending')),
        pending INTEGER NOT NULL CHECK(pending IN (0,1)), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        last_error TEXT, next_retry_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS power_state(
        device_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('on','off','unknown')), updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const suffix of ['', '-wal', '-shm']) {
      const file = this.path + suffix;
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  close(): void { this.secureFiles(); this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  activeClaims(): Claim[] {
    return this.db.prepare('SELECT user_id userId,device_id deviceId,session_id sessionId,started_at startedAt,accounted_at accountedAt FROM claims ORDER BY user_id').all() as unknown as Claim[];
  }
  claim(userId: string): Claim | undefined {
    return this.db.prepare('SELECT user_id userId,device_id deviceId,session_id sessionId,started_at startedAt,accounted_at accountedAt FROM claims WHERE user_id=?').get(userId) as unknown as Claim | undefined;
  }
  claimsOn(deviceId: string): Claim[] { return this.activeClaims().filter((claim) => claim.deviceId === deviceId); }

  createClaim(userId: string, deviceId: string, day: string, now: number): Claim {
    const sessionId = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO usage_sessions(id,user_id,device_id,day,started_at,accounted_at) VALUES(?,?,?,?,?,?)').run(sessionId, userId, deviceId, day, now, now);
      this.db.prepare('INSERT INTO claims(user_id,device_id,session_id,started_at,accounted_at) VALUES(?,?,?,?,?)').run(userId, deviceId, sessionId, now, now);
    });
    return { userId, deviceId, sessionId, startedAt: now, accountedAt: now };
  }

  account(claim: Claim, day: string, end: number): number {
    const seconds = end - claim.accountedAt;
    if (!Number.isInteger(seconds) || seconds <= 0) return 0;
    this.transaction(() => {
      this.db.prepare('INSERT INTO ledger(user_id,day,seconds,session_id,created_at) VALUES(?,?,?,?,?)').run(claim.userId, day, seconds, claim.sessionId, end);
      this.db.prepare('UPDATE usage_sessions SET seconds=seconds+?,accounted_at=? WHERE id=?').run(seconds, end, claim.sessionId);
      this.db.prepare('UPDATE claims SET accounted_at=? WHERE user_id=?').run(end, claim.userId);
    });
    return seconds;
  }

  end(userId: string, reason: string, now: number): Claim | undefined {
    const claim = this.claim(userId);
    if (!claim) return undefined;
    this.transaction(() => {
      this.db.prepare('DELETE FROM claims WHERE user_id=?').run(userId);
      this.db.prepare('UPDATE usage_sessions SET ended_at=?,end_reason=? WHERE id=?').run(now, reason, claim.sessionId);
    });
    return claim;
  }

  endMany(userIds: string[], reason: string, now: number): void {
    this.transaction(() => {
      for (const userId of userIds) {
        const claim = this.claim(userId);
        if (!claim) continue;
        this.db.prepare('DELETE FROM claims WHERE user_id=?').run(userId);
        this.db.prepare('UPDATE usage_sessions SET ended_at=?,end_reason=? WHERE id=?').run(now, reason, claim.sessionId);
      }
    });
  }

  usage(userId: string, day: string): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(seconds),0) total FROM ledger WHERE user_id=? AND day=?').get(userId, day) as { total: number | bigint }).total);
  }
  adjustmentTotal(userId: string, day: string): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(seconds),0) total FROM adjustments WHERE user_id=? AND day=?').get(userId, day) as { total: number | bigint }).total);
  }
  addAdjustment(userId: string, day: string, seconds: number, authorId: string, now: number): void {
    this.db.prepare('INSERT INTO adjustments(user_id,day,seconds,author_id,created_at) VALUES(?,?,?,?,?)').run(userId, day, seconds, authorId, now);
  }
  adjustments(userId: string): Array<{ seconds: number; authorId: string }> {
    return this.db.prepare('SELECT seconds,author_id authorId FROM adjustments WHERE user_id=? ORDER BY id DESC').all(userId) as unknown as Array<{ seconds: number; authorId: string }>;
  }

  setAcl(state: AclState): void {
    this.db.prepare(`INSERT INTO acl_state(device_id,desired_blocked,actual_blocked,baseline_blocked,source,pending,attempts,last_error,next_retry_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET desired_blocked=excluded.desired_blocked,
      actual_blocked=excluded.actual_blocked,baseline_blocked=excluded.baseline_blocked,source=excluded.source,
      pending=excluded.pending,attempts=excluded.attempts,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at,updated_at=excluded.updated_at`).run(
      state.deviceId, +state.desiredBlocked, state.actualBlocked === null ? null : +state.actualBlocked, +state.baselineBlocked,
      state.source, +state.pending, state.attempts, state.lastError, state.nextRetryAt, state.updatedAt
    );
  }

  aclState(deviceId: string): AclState | undefined {
    const row = this.db.prepare(`SELECT device_id deviceId,desired_blocked desiredBlocked,actual_blocked actualBlocked,
      baseline_blocked baselineBlocked,source,pending,attempts,last_error lastError,next_retry_at nextRetryAt,updated_at updatedAt
      FROM acl_state WHERE device_id=?`).get(deviceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { ...row, desiredBlocked: Boolean(row.desiredBlocked), actualBlocked: row.actualBlocked === null ? null : Boolean(row.actualBlocked), baselineBlocked: Boolean(row.baselineBlocked), pending: Boolean(row.pending) } as unknown as AclState;
  }
  aclStates(): AclState[] {
    const rows = this.db.prepare(`SELECT device_id deviceId,desired_blocked desiredBlocked,actual_blocked actualBlocked,
      baseline_blocked baselineBlocked,source,pending,attempts,last_error lastError,next_retry_at nextRetryAt,updated_at updatedAt
      FROM acl_state ORDER BY device_id`).all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      desiredBlocked: Boolean(row.desiredBlocked),
      actualBlocked: row.actualBlocked === null ? null : Boolean(row.actualBlocked),
      baselineBlocked: Boolean(row.baselineBlocked),
      pending: Boolean(row.pending)
    } as unknown as AclState));
  }
  audit(event: string, data: unknown, now: number): void {
    this.db.prepare('INSERT INTO audit(event,data,created_at) VALUES(?,?,?)').run(event, JSON.stringify(data), now);
  }
}
