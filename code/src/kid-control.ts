import { berlinDay, budgetFor, type Config, type UserConfig } from './domain.js';
import { Store, type Claim } from './store.js';

export interface AclController {
  read(deviceId: string): Promise<boolean>;
  setBlocked(deviceId: string, blocked: boolean): Promise<void>;
}
export type Power = 'on' | 'off' | 'unknown';

export class KidControl {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly config: Config,
    readonly store: Store,
    private readonly acl: AclController,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('KidControl is shutting down'));
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async drain(): Promise<void> { await this.queue; }
  async close(): Promise<void> { this.closed = true; await this.queue; }

  private user(id: string): UserConfig {
    const user = this.config.users.find((candidate) => candidate.id === id);
    if (!user) throw new Error('unknown user');
    return user;
  }
  private device(id: string) {
    const device = this.config.devices.find((candidate) => candidate.id === id);
    if (!device) throw new Error('unknown device');
    return device;
  }
  private now(): number { return Math.floor(this.clock().getTime() / 1000); }

  private remainingAt(user: UserConfig, epochSecond: number): number {
    if (user.role === 'superuser') return Number.MAX_SAFE_INTEGER;
    const at = new Date(epochSecond * 1000);
    const day = berlinDay(at, this.config.timezone);
    return Math.max(0, budgetFor(user, at, this.config.timezone) + this.store.adjustmentTotal(user.id, day) - this.store.usage(user.id, day));
  }

  status(userId: string) {
    const user = this.user(userId);
    const claim = this.store.claim(userId);
    return {
      userId,
      role: user.role,
      remainingSeconds: this.remainingAt(user, this.now()),
      unlimited: user.role === 'superuser',
      activeDeviceId: claim?.deviceId ?? null
    };
  }

  deviceStatuses() {
    return this.config.devices.map((device) => {
      const power = this.store.db.prepare('SELECT state FROM power_state WHERE device_id=?').get(device.id) as { state: Power } | undefined;
      const acl = this.store.aclState(device.id);
      return {
        id: device.id,
        displayName: device.displayName,
        power: power?.state ?? 'unknown',
        acl: acl?.actualBlocked === null || !acl ? 'unknown' : acl.pending ? 'degraded' : acl.actualBlocked ? 'blocked' : 'allowed'
      };
    });
  }

  private firstDifferentDay(start: number, end: number, day: string): number {
    let low = start + 1;
    let high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (berlinDay(new Date(middle * 1000), this.config.timezone) === day) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private chargeInternal(userId: string, until = this.now()): { exhausted: boolean; at: number } {
    let claim = this.store.claim(userId);
    if (!claim) return { exhausted: false, at: until };
    const user = this.config.users.find((candidate) => candidate.id === userId);
    if (!user) {
      this.store.end(userId, 'config-removed', claim.accountedAt);
      return { exhausted: false, at: claim.accountedAt };
    }
    while (claim.accountedAt < until) {
      const segmentStart = claim.accountedAt;
      const day = berlinDay(new Date(claim.accountedAt * 1000), this.config.timezone);
      const end = berlinDay(new Date((until - 1) * 1000), this.config.timezone) === day
        ? until
        : this.firstDifferentDay(claim.accountedAt, until, day);
      const available = user.role === 'superuser' ? end - claim.accountedAt : this.remainingAt(user, claim.accountedAt);
      const chargeEnd = Math.min(end, claim.accountedAt + available);
      if (chargeEnd > claim.accountedAt) this.store.account(claim, day, chargeEnd);
      claim = this.store.claim(userId);
      if (!claim) return { exhausted: false, at: chargeEnd };
      if (chargeEnd < end || (user.role === 'user' && this.remainingAt(user, chargeEnd) === 0)) {
        this.store.end(userId, 'budget-exhausted', chargeEnd);
        return { exhausted: true, at: chargeEnd };
      }
      if (chargeEnd <= segmentStart && chargeEnd < until) throw new Error('accounting made no progress');
      claim = this.store.claim(userId)!;
    }
    return { exhausted: false, at: until };
  }

  private async reconcileInternal(deviceId: string, resetBaseline = false): Promise<void> {
    const prior = this.store.aclState(deviceId);
    const baselineBlocked = resetBaseline ? true : prior?.baselineBlocked ?? true;
    const desired = this.store.claimsOn(deviceId).length === 0 ? baselineBlocked : false;
    const now = this.now();
    if (prior?.actualBlocked === desired) {
      this.store.setAcl({
        ...prior,
        desiredBlocked: desired,
        baselineBlocked,
        source: resetBaseline ? 'kidcontrol' : prior.source,
        pending: false,
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        updatedAt: now
      });
      return;
    }
    this.store.setAcl({
      deviceId, desiredBlocked: desired, actualBlocked: prior?.actualBlocked ?? null,
      baselineBlocked,
      source: 'pending', pending: true, attempts: prior?.attempts ?? 0,
      lastError: null, nextRetryAt: null, updatedAt: now
    });
    try {
      await this.acl.setBlocked(deviceId, desired);
      this.store.setAcl({
        deviceId, desiredBlocked: desired, actualBlocked: desired, baselineBlocked,
        source: 'kidcontrol', pending: false, attempts: 0, lastError: null, nextRetryAt: null, updatedAt: this.now()
      });
    } catch (error) {
      const attempts = (prior?.attempts ?? 0) + 1;
      const message = error instanceof Error ? error.message : 'ACL update failed';
      this.store.setAcl({
        deviceId, desiredBlocked: desired, actualBlocked: prior?.actualBlocked ?? null,
        baselineBlocked, source: 'pending', pending: true, attempts,
        lastError: message.slice(0, 500), nextRetryAt: now + Math.min(300, 2 ** Math.min(attempts, 8)), updatedAt: now
      });
      throw error;
    }
  }

  start(userId: string, deviceId: string): Promise<void> { return this.enqueue(() => this.startInternal(userId, deviceId)); }
  private async startInternal(userId: string, deviceId: string): Promise<void> {
    const user = this.user(userId);
    this.device(deviceId);
    const existing = this.store.claim(userId);
    if (existing?.deviceId === deviceId) return;
    if (existing) {
      this.chargeInternal(userId);
      this.store.end(userId, 'switch', this.now());
      try { await this.reconcileInternal(existing.deviceId); } catch { /* durable pending */ }
    }
    if (user.role === 'user' && this.remainingAt(user, this.now()) <= 0) throw new Error('budget exhausted');
    const occupants = this.store.claimsOn(deviceId);
    if (user.role === 'superuser') {
      for (const claim of occupants) {
        const occupant = this.config.users.find((candidate) => candidate.id === claim.userId);
        if (occupant?.role === 'user') this.chargeInternal(claim.userId);
      }
      this.store.endMany(occupants.filter((claim) => this.config.users.find((u) => u.id === claim.userId)?.role === 'user').map((claim) => claim.userId), 'superuser-displaced', this.now());
    } else if (occupants.some((claim) => this.config.users.find((candidate) => candidate.id === claim.userId)?.role === 'superuser')) {
      throw new Error('device reserved by superuser');
    }
    const firstClaim = this.store.claimsOn(deviceId).length === 0;
    this.store.createClaim(userId, deviceId, berlinDay(this.clock(), this.config.timezone), this.now());
    if (firstClaim) {
      try { await this.reconcileInternal(deviceId); }
      catch (error) {
        this.store.end(userId, 'activation-failed', this.now());
        const failed = this.store.aclState(deviceId);
        if (failed) this.store.setAcl({ ...failed, actualBlocked: null, updatedAt: this.now() });
        try { await this.reconcileInternal(deviceId); } catch { /* safe baseline remains pending */ }
        throw error;
      }
    }
  }

  stop(userId: string): Promise<void> { return this.enqueue(() => this.stopInternal(userId, 'user-stop')); }
  private async stopInternal(userId: string, reason: string): Promise<void> {
    const claim = this.store.claim(userId);
    if (!claim) return;
    this.chargeInternal(userId);
    this.store.end(userId, reason, this.now());
    try { await this.reconcileInternal(claim.deviceId); } catch { /* durable pending */ }
  }

  tick(): Promise<void> { return this.enqueue(() => this.tickInternal()); }
  private accountActiveInternal(): Set<string> {
    const affected = new Set<string>();
    for (const claim of this.store.activeClaims()) {
      const result = this.chargeInternal(claim.userId);
      if (result.exhausted || !this.store.claim(claim.userId)) affected.add(claim.deviceId);
    }
    return affected;
  }
  private async tickInternal(): Promise<void> {
    const affected = this.accountActiveInternal();
    for (const deviceId of affected) {
      try { await this.reconcileInternal(deviceId); } catch { /* durable pending state retries later */ }
    }
    await this.retryPendingInternal();
  }

  powerChanged(deviceId: string, state: Power): Promise<void> { return this.enqueue(() => this.powerInternal(deviceId, state)); }
  private async powerInternal(deviceId: string, state: Power): Promise<void> {
    this.device(deviceId);
    this.store.db.prepare(`INSERT INTO power_state VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`).run(deviceId, state, this.now());
    if (state !== 'off') return;
    const regular = this.store.claimsOn(deviceId).filter((claim) => this.config.users.find((user) => user.id === claim.userId)?.role === 'user');
    for (const claim of regular) this.chargeInternal(claim.userId);
    this.store.endMany(regular.map((claim) => claim.userId), 'standby', this.now());
    try { await this.reconcileInternal(deviceId); } catch { /* pending */ }
  }

  setRemaining(authorId: string, userId: string, seconds: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.user(authorId).role !== 'superuser') throw new Error('superuser required');
      const target = this.user(userId);
      if (target.role !== 'user') throw new Error('target must be a regular user');
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 89_940) throw new Error('remaining time must be 00:00 through 24:59');
      const priorClaim = this.store.claim(userId);
      this.chargeInternal(userId);
      const delta = seconds - this.remainingAt(target, this.now());
      this.store.addAdjustment(userId, berlinDay(this.clock(), this.config.timezone), delta, authorId, this.now());
      if (seconds === 0 && this.store.claim(userId)) await this.stopInternal(userId, 'adjustment-exhausted');
      else if (priorClaim && !this.store.claim(userId)) {
        try { await this.reconcileInternal(priorClaim.deviceId); } catch { /* durable pending */ }
      }
    });
  }

  adoptAcl(deviceId: string, blocked: boolean): Promise<void> { return this.enqueue(() => this.adoptInternal(deviceId, blocked)); }
  private async adoptInternal(deviceId: string, blocked: boolean): Promise<void> {
    this.device(deviceId);
    if (blocked) {
      const claims = this.store.claimsOn(deviceId);
      for (const claim of claims) this.chargeInternal(claim.userId);
      this.store.endMany(claims.map((claim) => claim.userId), 'external-block', this.now());
    }
    this.store.setAcl({ deviceId, desiredBlocked: blocked, actualBlocked: blocked, baselineBlocked: blocked, source: 'external', pending: false, attempts: 0, lastError: null, nextRetryAt: null, updatedAt: this.now() });
    this.store.audit('acl-adopted', { deviceId, blocked }, this.now());
  }

  recover(): Promise<void> { return this.enqueue(() => this.recoverInternal()); }
  private async recoverInternal(): Promise<void> {
    const configuredDevices = new Set(this.config.devices.map((device) => device.id));
    const removedClaims = this.store.activeClaims().filter((claim) => !configuredDevices.has(claim.deviceId));
    const removedAllowedState = this.store.aclStates().filter((state) =>
      !configuredDevices.has(state.deviceId) && (state.actualBlocked === false || state.desiredBlocked === false || state.pending)
    );
    const removed = [...new Set([
      ...removedClaims.map((claim) => claim.deviceId),
      ...removedAllowedState.map((state) => state.deviceId)
    ])];
    if (removed.length > 0) {
      throw new Error(`removed managed device may still be allowed: ${removed.join(', ')}; restore the previous configuration before migration`);
    }
    const affected = this.accountActiveInternal();
    for (const claim of this.store.activeClaims()) {
      if (!this.config.users.some((user) => user.id === claim.userId) || !this.config.devices.some((device) => device.id === claim.deviceId)) {
        this.store.end(claim.userId, 'config-removed', this.now());
        affected.add(claim.deviceId);
      }
    }
    for (const device of this.config.devices) {
      try {
        const actual = await this.acl.read(device.id);
        const state = this.store.aclState(device.id);
        if (actual && this.store.claimsOn(device.id).length > 0) {
          await this.adoptInternal(device.id, true);
          continue;
        }
        if (state?.pending) {
          if (actual === state.desiredBlocked) {
            this.store.setAcl({ ...state, actualBlocked: actual, source: 'kidcontrol', pending: false, attempts: 0, lastError: null, nextRetryAt: null, updatedAt: this.now() });
          } else {
            this.store.setAcl({ ...state, actualBlocked: actual, updatedAt: this.now() });
            if (state.nextRetryAt === null || state.nextRetryAt <= this.now()) {
              try { await this.reconcileInternal(device.id); } catch { /* remains pending */ }
            }
          }
        } else if (!state || state.actualBlocked !== actual) {
          await this.adoptInternal(device.id, actual);
        } else {
          this.store.setAcl({ ...state, actualBlocked: actual, updatedAt: this.now() });
        }
        if (affected.has(device.id)) {
          try { await this.reconcileInternal(device.id); } catch { /* remains pending */ }
        }
      } catch (error) {
        const state = this.store.aclState(device.id);
        this.store.setAcl({
          deviceId: device.id, desiredBlocked: state?.desiredBlocked ?? true, actualBlocked: null,
          baselineBlocked: state?.baselineBlocked ?? true, source: state?.source ?? 'baseline', pending: state?.pending ?? false,
          attempts: state?.attempts ?? 0, lastError: (error instanceof Error ? error.message : 'ACL unavailable').slice(0, 500),
          nextRetryAt: state?.nextRetryAt ?? null, updatedAt: this.now()
        });
      }
    }
  }

  poll(): Promise<void> { return this.enqueue(async () => {
    const affected = this.accountActiveInternal();
    for (const deviceId of affected) {
      try { await this.reconcileInternal(deviceId); } catch { /* remains pending */ }
    }
    for (const device of this.config.devices) {
      try {
        const actual = await this.acl.read(device.id);
        const state = this.store.aclState(device.id);
        if (actual && this.store.claimsOn(device.id).length > 0) {
          await this.adoptInternal(device.id, true);
        } else if (state?.pending) {
          if (actual === state.desiredBlocked) {
            this.store.setAcl({ ...state, actualBlocked: actual, source: 'kidcontrol', pending: false, attempts: 0, lastError: null, nextRetryAt: null, updatedAt: this.now() });
          } else {
            this.store.setAcl({ ...state, actualBlocked: actual, updatedAt: this.now() });
            if (state.nextRetryAt === null || state.nextRetryAt <= this.now()) {
              try { await this.reconcileInternal(device.id); } catch { /* remains pending */ }
            }
          }
        } else if (!state || state.actualBlocked !== actual) {
          await this.adoptInternal(device.id, actual);
        }
      } catch (error) {
        const state = this.store.aclState(device.id);
        this.store.setAcl({
          deviceId: device.id, desiredBlocked: state?.desiredBlocked ?? true, actualBlocked: null,
          baselineBlocked: state?.baselineBlocked ?? true, source: state?.source ?? 'baseline', pending: state?.pending ?? false,
          attempts: state?.attempts ?? 0, lastError: (error instanceof Error ? error.message : 'ACL unavailable').slice(0, 500),
          nextRetryAt: state?.nextRetryAt ?? null, updatedAt: this.now()
        });
      }
    }
  }); }

  private async retryPendingInternal(): Promise<void> {
    for (const device of this.config.devices) {
      const state = this.store.aclState(device.id);
      if (state?.pending && (state.nextRetryAt === null || state.nextRetryAt <= this.now())) {
        try { await this.reconcileInternal(device.id); } catch { /* bounded durable retry */ }
      }
    }
  }

  restore(authorId: string): Promise<void> { return this.enqueue(async () => {
    if (this.user(authorId).role !== 'superuser') throw new Error('superuser required');
    for (const device of this.config.devices) {
      const prior = this.store.aclState(device.id);
      if (prior) this.store.setAcl({ ...prior, baselineBlocked: true, source: 'pending', pending: true, updatedAt: this.now() });
      try { await this.reconcileInternal(device.id, true); } catch { /* durable pending */ }
    }
    this.store.audit('state-restored', { authorId }, this.now());
  }); }
}
