// @ts-nocheck
import { FEATURE_CACHE_ENTRY_BYTES, type DerivedFeatureCache } from '../application/feature-cache';

export const FEATURE_CACHE_DIRECTORY = 'harmonia-features-v1';
export const FEATURE_CACHE_LOCK = 'harmonia-derived-features-v1';
const INDEX = 'index.json',
  INDEX_LIMIT = 64 * 1024,
  SCAN_LIMIT = 128;
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
interface Entry {
  key: string;
  file: string;
  bytes: number;
  checksum: string;
  touched: number;
}
export interface FeatureFiles {
  read(name: string, limit: number): Promise<ArrayBuffer | null>;
  write(name: string, bytes: ArrayBuffer): Promise<void>;
  remove(name: string): Promise<void>;
  size(name: string): Promise<number | null>;
  names(): AsyncIterable<string>;
}
type Lock = <T>(operation: () => Promise<T>) => Promise<T | null>;
interface Limits {
  bytes: number;
  entries: number;
  ttl: number;
}
const defaults: Limits = { bytes: 128 * 1024 * 1024, entries: 32, ttl: 30 * 86400000 };
async function checksum(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export class FilesystemFeatureCache implements DerivedFeatureCache {
  private disabled = false;
  constructor(
    private files: FeatureFiles,
    private lock: Lock,
    private now = Date.now,
    private limits: Limits = defaults,
    private timeoutMs = 2000,
  ) {}
  private async optional<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.disabled) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The complete lock promise owns its real I/O lifetime, including after timeout.
    // Never resolve the lock callback early while a file write can still continue.
    const pending = this.lock(operation).catch(() => null);
    try {
      return await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            this.disabled = true;
            resolve(null);
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async index(): Promise<Entry[]> {
    try {
      const bytes = await this.files.read(INDEX, INDEX_LIMIT);
      if (!bytes) return [];
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (
        value.version !== 1 ||
        !Array.isArray(value.entries) ||
        value.entries.length > this.limits.entries
      )
        return [];
      const entries = value.entries as Entry[];
      if (
        entries.some(
          (e) =>
            !e ||
            !validKey(e.key) ||
            !validKey(e.checksum) ||
            !/^feature-[a-f0-9-]{36}\.bin$/.test(e.file) ||
            !Number.isSafeInteger(e.bytes) ||
            e.bytes <= 0 ||
            e.bytes > FEATURE_CACHE_ENTRY_BYTES ||
            !Number.isFinite(e.touched) ||
            e.touched < 0 ||
            e.touched > this.now() + 60000,
        ) ||
        new Set(entries.map((e) => e.key)).size !== entries.length ||
        new Set(entries.map((e) => e.file)).size !== entries.length ||
        entries.reduce((sum, e) => sum + e.bytes, 0) > this.limits.bytes
      )
        return [];
      return entries;
    } catch {
      return [];
    }
  }
  private async save(entries: Entry[]): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, entries }));
    if (bytes.byteLength > INDEX_LIMIT) throw new Error('Feature index exceeds bound');
    await this.files.write(INDEX, bytes.buffer);
  }
  private async clean(): Promise<Entry[] | null> {
    const entries: Entry[] = [];
    for (const entry of await this.index()) {
      if (
        this.now() - entry.touched <= this.limits.ttl &&
        (await this.files.size(entry.file)) === entry.bytes
      )
        entries.push(entry);
    }
    const retained = new Set(entries.map((e) => e.file));
    let visited = 0;
    for await (const name of this.files.names()) {
      if (++visited > SCAN_LIMIT) return null;
      if (name !== INDEX && !retained.has(name)) await this.files.remove(name);
    }
    return entries;
  }
  async read(key: string): Promise<ArrayBuffer | null> {
    if (!validKey(key)) return null;
    try {
      return await this.optional(async () => {
        const entries = await this.clean();
        if (!entries) return null;
        const entry = entries.find((e) => e.key === key);
        let bytes: ArrayBuffer | null = null;
        if (entry) {
          try {
            bytes = await this.files.read(entry.file, FEATURE_CACHE_ENTRY_BYTES);
          } catch {
            /* corrupt file */
          }
          if (
            !bytes ||
            bytes.byteLength !== entry.bytes ||
            (await checksum(bytes)) !== entry.checksum
          ) {
            await this.files.remove(entry.file);
            entries.splice(entries.indexOf(entry), 1);
            bytes = null;
          } else entry.touched = this.now();
        }
        await this.save(entries);
        return bytes;
      });
    } catch {
      return null;
    }
  }
  async write(key: string, bytes: ArrayBuffer): Promise<void> {
    if (
      !validKey(key) ||
      !bytes.byteLength ||
      bytes.byteLength > Math.min(FEATURE_CACHE_ENTRY_BYTES, this.limits.bytes)
    )
      return;
    try {
      await this.optional(async () => {
        let entries = await this.clean();
        if (!entries) return;
        const old = entries.find((e) => e.key === key);
        if (old) await this.files.remove(old.file);
        entries = entries.filter((e) => e.key !== key).sort((a, b) => a.touched - b.touched);
        while (
          entries.length >= this.limits.entries ||
          entries.reduce((sum, e) => sum + e.bytes, 0) + bytes.byteLength > this.limits.bytes
        ) {
          await this.files.remove(entries.shift()!.file);
        }
        const file = `feature-${crypto.randomUUID()}.bin`;
        const digest = await checksum(bytes);
        await this.files.write(file, bytes);
        entries.push({ key, file, bytes: bytes.byteLength, checksum: digest, touched: this.now() });
        await this.save(entries);
      });
    } catch {
      /* Optional cache; interrupted writes are reclaimed on the next operation. */
    }
  }
  async remove(key: string): Promise<void> {
    try {
      await this.optional(async () => {
        const entries = await this.clean();
        if (!entries) return;
        for (const entry of entries.filter((e) => e.key === key))
          await this.files.remove(entry.file);
        await this.save(entries.filter((e) => e.key !== key));
      });
    } catch {
      /* Optional cleanup. */
    }
  }
  async clear(): Promise<void> {
    try {
      await this.optional(async () => {
        await this.save([]);
        await this.clean();
      });
    } catch {
      /* Optional cleanup. */
    }
  }
}
class OpfsFiles implements FeatureFiles {
  constructor(private directory: FileSystemDirectoryHandle) {}
  async read(name: string, limit: number): Promise<ArrayBuffer | null> {
    try {
      const file = await (await this.directory.getFileHandle(name)).getFile();
      if (file.size > limit) throw new Error('Feature file exceeds bound');
      return file.arrayBuffer();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }
  async write(name: string, bytes: ArrayBuffer): Promise<void> {
    const stream = await (
      await this.directory.getFileHandle(name, { create: true })
    ).createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => undefined);
      throw error;
    }
  }
  async size(name: string): Promise<number | null> {
    try {
      return (await (await this.directory.getFileHandle(name)).getFile()).size;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }
  async remove(name: string): Promise<void> {
    try {
      await this.directory.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  }
  async *names(): AsyncIterable<string> {
    const iterable = this.directory as FileSystemDirectoryHandle & {
      keys(): AsyncIterable<string>;
    };
    yield* iterable.keys();
  }
}
export async function createFeatureCache(timeoutMs = 2000): Promise<DerivedFeatureCache | null> {
  // Never instantiate this storage path on the presentation thread.
  if (
    typeof window !== 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.storage?.getDirectory ||
    !navigator.locks?.request
  )
    return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(FEATURE_CACHE_DIRECTORY, { create: true }))
      .catch(() => null);
    const directory = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!directory) return null;
    const lock: Lock = (operation) =>
      navigator.locks.request(
        FEATURE_CACHE_LOCK,
        { mode: 'exclusive', ifAvailable: true },
        (held) => (held ? operation() : null),
      );
    return new FilesystemFeatureCache(new OpfsFiles(directory), lock);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
