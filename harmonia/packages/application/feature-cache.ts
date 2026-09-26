// @ts-nocheck
/** Optional derived binary artifacts. Cache failure must never fail valid analysis. */
export interface DerivedFeatureCache {
  read(key: string): Promise<ArrayBuffer | null>;
  write(key: string, bytes: ArrayBuffer): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}
export const FEATURE_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;
