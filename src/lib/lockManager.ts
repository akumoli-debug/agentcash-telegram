import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

export interface LockLease {
  key: string;
  token: string;
}

export interface LockManager {
  acquire(key: string, ttlMs: number): Promise<LockLease>;
  release(lease: LockLease): Promise<void>;
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

  async acquire(key: string, ttlMs: number): Promise<LockLease> {
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

  async release(lease: LockLease): Promise<void> {
    if (lease.token === "reentrant") {
      return;
    }

    const current = this.locks.get(lease.key);
    if (!current || current.token !== lease.token) {
      return;
    }

    current.release();
    this.locks.delete(lease.key);
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const held = heldLocks.getStore();
    if (held?.has(key)) {
      return fn();
    }

    const lease = await this.acquire(key, ttlMs);
    const nextHeld = new Set(held ?? []);
    nextHeld.add(key);

    try {
      return await heldLocks.run(nextHeld, fn);
    } finally {
      await this.release(lease);
    }
  }
}

export const defaultLockManager = new LocalLockManager();
