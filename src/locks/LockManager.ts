import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { AppConfig } from "../config.js";
import { ConfigError, LockUnavailableError } from "../lib/errors.js";

export interface LockHandle {
  key: string;
  token: string;
}

export interface LockManager {
  acquire(key: string, ttlMs: number): Promise<LockHandle>;
  release(handle: LockHandle): Promise<void>;
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

interface LocalLockState {
  token: string;
  expiresAt: number;
  released: Promise<void>;
  release: () => void;
}

const heldLocks = new AsyncLocalStorage<Set<string>>();

export class LocalLockManager implements LockManager {
  private readonly locks = new Map<string, LocalLockState>();

  async acquire(key: string, ttlMs: number): Promise<LockHandle> {
    const held = heldLocks.getStore();
    if (held?.has(key)) {
      return { key, token: "reentrant" };
    }

    while (true) {
      const current = this.locks.get(key);
      const now = Date.now();

      if (!current || current.expiresAt <= now) {
        const token = crypto.randomUUID();
        let release!: () => void;
        const released = new Promise<void>(resolve => {
          release = resolve;
        });
        this.locks.set(key, {
          token,
          expiresAt: now + ttlMs,
          released,
          release
        });

        return { key, token };
      }

      await current.released;
    }
  }

  async release(handle: LockHandle): Promise<void> {
    if (handle.token === "reentrant") {
      return;
    }

    const current = this.locks.get(handle.key);
    if (!current || current.token !== handle.token) {
      return;
    }

    current.release();
    this.locks.delete(handle.key);
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const held = heldLocks.getStore();
    if (held?.has(key)) {
      return fn();
    }

    const handle = await this.acquire(key, ttlMs);
    const nextHeld = new Set(held ?? []);
    nextHeld.add(key);

    try {
      return await heldLocks.run(nextHeld, fn);
    } finally {
      await this.release(handle);
    }
  }
}

export interface RedisLockClient {
  isOpen: boolean;
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export class RedisLockManager implements LockManager {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: RedisLockClient,
    options: { keyPrefix?: string } = {}
  ) {
    this.keyPrefix = options.keyPrefix ?? "agentcash:lock:";
  }

  async acquire(key: string, ttlMs: number): Promise<LockHandle> {
    if (ttlMs <= 0) {
      throw new ConfigError("Redis lock TTL must be positive");
    }

    const token = crypto.randomUUID();
    const redisKey = this.redisKey(key);

    try {
      if (!this.client.isOpen) {
        await this.client.connect();
      }

      const acquired = await this.client.set(redisKey, token, { NX: true, PX: ttlMs });
      if (acquired !== "OK") {
        throw new LockUnavailableError();
      }

      return { key, token };
    } catch (error) {
      if (error instanceof LockUnavailableError) {
        throw error;
      }

      throw new LockUnavailableError(
        "The concurrency lock service is unavailable. No paid action was submitted.",
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  async release(handle: LockHandle): Promise<void> {
    try {
      if (!this.client.isOpen) {
        await this.client.connect();
      }

      await this.client.eval(
        `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          end
          return 0
        `,
        { keys: [this.redisKey(handle.key)], arguments: [handle.token] }
      );
    } catch (error) {
      throw new LockUnavailableError(
        "The concurrency lock release is uncertain. No further paid action was submitted.",
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const handle = await this.acquire(key, ttlMs);
    try {
      return await fn();
    } finally {
      await this.release(handle);
    }
  }

  private redisKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

export function createLockManager(config: AppConfig): LockManager {
  if (config.LOCK_PROVIDER === "redis") {
    if (!config.REDIS_URL) {
      throw new ConfigError("REDIS_URL is required when LOCK_PROVIDER=redis");
    }

    return new RedisLockManager(createClient({ url: config.REDIS_URL }) as RedisClientType as RedisLockClient);
  }

  if (config.NODE_ENV === "production" && !config.ALLOW_LOCAL_LOCKS_IN_PRODUCTION) {
    throw new ConfigError("LOCK_PROVIDER=local is process-local and blocked in production");
  }

  return defaultLockManager;
}

export const defaultLockManager = new LocalLockManager();
