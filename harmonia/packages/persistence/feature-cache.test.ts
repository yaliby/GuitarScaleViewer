// @ts-nocheck
import { expect, it, vi } from 'vitest';
import { FilesystemFeatureCache, createFeatureCache, type FeatureFiles } from './feature-cache';

class MemoryFiles implements FeatureFiles {
  files = new Map<string, Uint8Array>();
  failIndex = false;
  async read(name: string, limit: number) {
    const value = this.files.get(name);
    if (!value) return null;
    if (value.byteLength > limit) throw new Error('size');
    return value.slice().buffer;
  }
  async write(name: string, value: ArrayBuffer) {
    if (this.failIndex && name === 'index.json') throw new Error('interrupted publication');
    this.files.set(name, new Uint8Array(value).slice());
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async size(name: string) {
    return this.files.get(name)?.byteLength ?? null;
  }
  async *names() {
    yield* this.files.keys();
  }
}
const key = (n: number) => n.toString(16).padStart(64, '0');
const bytes = (n: number) => new Uint8Array([n, 2, 3]).buffer;
const lock = async <T>(operation: () => Promise<T>) => operation();
it('detects changed payload bytes and deletes corrupt entries', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, lock);
  await cache.write(key(1), bytes(1));
  expect(await cache.read(key(1))).toEqual(bytes(1));
  const name = [...files.files.keys()].find((n) => n.endsWith('.bin'))!;
  files.files.set(name, new Uint8Array([8, 2, 3]));
  expect(await cache.read(key(1))).toBeNull();
  expect(files.files.has(name)).toBe(false);
});
it('evicts least-recently-used entries and expires idle entries within byte bounds', async () => {
  const files = new MemoryFiles();
  let now = 1;
  const cache = new FilesystemFeatureCache(files, lock, () => now, {
    bytes: 6,
    entries: 2,
    ttl: 10,
  });
  await cache.write(key(1), bytes(1));
  now++;
  await cache.write(key(2), bytes(2));
  now++;
  await cache.read(key(1));
  now++;
  await cache.write(key(3), bytes(3));
  expect(await cache.read(key(2))).toBeNull();
  expect(await cache.read(key(1))).toEqual(bytes(1));
  now = 20;
  expect(await cache.read(key(1))).toBeNull();
  expect([...files.files.keys()].filter((n) => n.endsWith('.bin'))).toEqual([]);
});
it('recovers interrupted publication orphans and does not expose partial data', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, lock);
  files.failIndex = true;
  await cache.write(key(1), bytes(1));
  files.failIndex = false;
  expect(await cache.read(key(1))).toBeNull();
  expect([...files.files.keys()].filter((n) => n.endsWith('.bin'))).toEqual([]);
});
it('skips storage without waiting when another worker owns the lock', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, async () => null);
  await cache.write(key(1), bytes(1));
  expect(await cache.read(key(1))).toBeNull();
  expect(files.files.size).toBe(0);
});
it('reclaims oversized retained files without reading their payloads on unrelated misses', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, lock);
  await cache.write(key(1), bytes(1));
  const name = [...files.files.keys()].find((n) => n.endsWith('.bin'))!;
  files.files.set(name, new Uint8Array(100));
  await cache.read(key(2));
  expect(files.files.has(name)).toBe(false);
});
it('bounds each interrupted-write orphan cleanup and eventually recovers', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, lock);
  for (let i = 0; i < 300; i++) files.files.set(`orphan-${i}`, new Uint8Array(1));
  await cache.read(key(1));
  expect(files.files.size).toBe(172);
  await cache.read(key(1));
  await cache.write(key(1), bytes(1));
  expect(await cache.read(key(1))).toEqual(bytes(1));
  expect(files.files.size).toBe(2);
});
it('times out stalled reads without releasing their lock and disables subsequent writes', async () => {
  const files = new MemoryFiles();
  let finish!: (value: ArrayBuffer | null) => void;
  files.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let held = false;
  const heldLock = async <T>(operation: () => Promise<T>) => {
    held = true;
    try {
      return await operation();
    } finally {
      held = false;
    }
  };
  const cache = new FilesystemFeatureCache(files, heldLock, Date.now, undefined, 5);
  expect(await cache.read(key(1))).toBeNull();
  expect(held).toBe(true);
  await cache.write(key(2), bytes(2));
  expect(files.files.size).toBe(0);
  finish(null);
  await vi.waitFor(() => expect(held).toBe(false));
});
it('times out stalled payload writes while keeping the outstanding lock held', async () => {
  const files = new MemoryFiles();
  let finish!: () => void;
  files.write = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let held = false;
  const heldLock = async <T>(operation: () => Promise<T>) => {
    held = true;
    try {
      return await operation();
    } finally {
      held = false;
    }
  };
  const cache = new FilesystemFeatureCache(files, heldLock, Date.now, undefined, 5);
  await cache.write(key(1), bytes(1));
  expect(held).toBe(true);
  expect(await cache.read(key(1))).toBeNull();
  files.write = async () => undefined;
  finish();
  await vi.waitFor(() => expect(held).toBe(false));
});
it('skips a stalled OPFS initialization rather than blocking analysis', async () => {
  vi.stubGlobal('navigator', {
    storage: { getDirectory: () => new Promise(() => undefined) },
    locks: { request: () => undefined },
  });
  try {
    expect(await createFeatureCache(5)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('resets an invalid index, skips oversized entries, and treats quota denial as optional', async () => {
  const files = new MemoryFiles();
  const cache = new FilesystemFeatureCache(files, lock);
  files.files.set('index.json', new TextEncoder().encode('{broken'));
  files.files.set('orphan.bin', new Uint8Array([1]));
  expect(await cache.read(key(1))).toBeNull();
  expect(files.files.has('orphan.bin')).toBe(false);
  await cache.write(key(1), new ArrayBuffer(16 * 1024 * 1024 + 1));
  expect(files.files.size).toBe(1);
  files.write = async () => {
    throw new DOMException('Full', 'QuotaExceededError');
  };
  await expect(cache.write(key(1), bytes(1))).resolves.toBeUndefined();
  expect(await cache.read(key(1))).toBeNull();
});
