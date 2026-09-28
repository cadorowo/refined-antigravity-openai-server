import { classifyProfileFailure } from "./failure-classifier.js";
import { ProfileRuntime } from "./profile-runtime.js";
import type {
  AcquireOptions,
  FailoverOptions,
  ProfileLease,
  ProfileSnapshot,
} from "./types.js";

export class NoAvailableProfileError extends Error {
  constructor(message: string = "No Antigravity profile is currently available") {
    super(message);
    this.name = "NoAvailableProfileError";
  }
}

export class ProfileManager {
  private readonly profiles = new Map<string, ProfileRuntime>();

  constructor(profiles: Iterable<ProfileRuntime> = []) {
    for (const profile of profiles) {
      this.add(profile);
    }
  }

  public add(profile: ProfileRuntime): void {
    if (this.profiles.has(profile.id)) {
      throw new Error(`Profile with id '${profile.id}' is already registered`);
    }
    this.profiles.set(profile.id, profile);
  }

  public get(id: string): ProfileRuntime | undefined {
    return this.profiles.get(id);
  }

  public list(): ProfileRuntime[] {
    return [...this.profiles.values()];
  }

  public snapshots(): ProfileSnapshot[] {
    return [...this.profiles.values()].map((p) => p.snapshot());
  }

  public async startAll(): Promise<PromiseSettledResult<void>[]> {
    const promises = [...this.profiles.values()]
      .filter((p) => p.config.enabled)
      .map((p) => p.start());
    return Promise.allSettled(promises);
  }

  public async closeAll(): Promise<void> {
    await Promise.allSettled([...this.profiles.values()].map((p) => p.close()));
  }

  public resetProfile(id: string): void {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Unknown profile id: ${id}`);
    }
    profile.markReady();
  }

  public async restartProfile(id: string): Promise<void> {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Unknown profile id: ${id}`);
    }
    await profile.restart();
  }

  /**
   * Acquires a lease on an available profile following priority and affinity rules.
   * Enforces 1 active foreground lease per ProfileRuntime.
   */
  public acquire(options: AcquireOptions = {}): ProfileLease {
    const excluded = new Set(options.excludeProfileIds ?? []);
    const eligible = options.eligibleProfileIds ? new Set(options.eligibleProfileIds) : null;

    // 1. Session affinity: check if preferredProfileId is ready and available
    if (options.preferredProfileId && !excluded.has(options.preferredProfileId)) {
      if (!eligible || eligible.has(options.preferredProfileId)) {
        const preferred = this.profiles.get(options.preferredProfileId);
        if (preferred && preferred.config.enabled && preferred.currentState === "ready") {
          preferred.acquireLease();
          return this.createLease(preferred);
        }
      }
    }

    // 2. Select best available candidate based on priority, load, and ID
    const candidates = [...this.profiles.values()]
      .filter((p) => !excluded.has(p.id))
      .filter((p) => !eligible || eligible.has(p.id))
      .filter((p) => p.config.enabled && p.currentState === "ready")
      .sort((a, b) => {
        const priorityA = a.config.priority ?? 100;
        const priorityB = b.config.priority ?? 100;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        if (a.activeLeaseCount !== b.activeLeaseCount) {
          return a.activeLeaseCount - b.activeLeaseCount;
        }
        return a.id.localeCompare(b.id);
      });

    const selected = candidates[0];
    if (!selected) {
      throw new NoAvailableProfileError(
        `No Antigravity profile is currently available (total: ${this.profiles.size}, excluded: ${excluded.size})`,
      );
    }

    selected.acquireLease();
    return this.createLease(selected);
  }

  /**
   * Executes an operation with an acquired profile lease, guaranteeing release.
   */
  public async withProfile<T>(
    operation: (profile: ProfileRuntime) => Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const lease = this.acquire(options);
    try {
      const result = await operation(lease.profile);
      lease.profile.markSuccess();
      return result;
    } finally {
      lease.release();
    }
  }

  /**
   * Executes an operation with controlled failover.
   * If a profile fails with a retryable classification (rate limit, quota, auth, transient),
   * the failure is recorded on that profile and the next candidate profile is attempted.
   * Unknown/fatal errors stop immediately and are propagated.
   */
  public async withFailover<T>(
    operation: (profile: ProfileRuntime, attempt: number) => Promise<T>,
    options: FailoverOptions = {},
  ): Promise<T> {
    const attempted = new Set(options.excludeProfileIds ?? []);
    const classify = options.classifyFailure ?? classifyProfileFailure;
    const maxAttempts = options.maxAttempts ?? Math.max(1, this.profiles.size);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let lease: ProfileLease;
      try {
        lease = this.acquire({
          ...options,
          excludeProfileIds: attempted,
        });
      } catch (acquireError) {
        if (acquireError instanceof NoAvailableProfileError && lastError) {
          throw lastError;
        }
        throw acquireError;
      }

      attempted.add(lease.profile.id);

      try {
        const result = await operation(lease.profile, attempt);
        lease.profile.markSuccess();
        return result;
      } catch (error) {
        lastError = error;
        const classification = classify(error);

        lease.profile.markFailure(
          classification.kind,
          error,
          classification.cooldownMs,
        );

        // If not retryable, immediately abort failover and rethrow
        if (!classification.retryableOnAnotherProfile) {
          throw error;
        }
      } finally {
        lease.release();
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    if (lastError !== undefined) {
      throw new Error(String(lastError));
    }
    throw new NoAvailableProfileError();
  }

  private createLease(profile: ProfileRuntime): ProfileLease {
    let released = false;
    return {
      profile,
      release: () => {
        if (released) return;
        released = true;
        profile.releaseLease();
      },
    };
  }
}
