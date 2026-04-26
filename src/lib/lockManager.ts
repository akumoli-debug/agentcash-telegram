export {
  LocalLockManager,
  RedisLockManager,
  createLockManager,
  defaultLockManager,
  type LockHandle as LockLease,
  type LockHandle,
  type LockManager,
  type RedisLockClient
} from "../locks/LockManager.js";
