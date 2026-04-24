const pending = new Map<string, Promise<void>>();

export async function withUserLock<T>(userHash: string, fn: () => Promise<T>): Promise<T> {
  const prev = pending.get(userHash) ?? Promise.resolve();
  let release!: () => void;
  const curr = new Promise<void>(r => {
    release = r;
  });
  pending.set(userHash, curr);

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (pending.get(userHash) === curr) {
      pending.delete(userHash);
    }
  }
}
