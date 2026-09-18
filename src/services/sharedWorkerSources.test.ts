import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `chordsync-api` is a separate package and cannot import from `src/`, so these modules are
 * copied into it by `scripts/sync-worker-src.sh`. Drift here is invisible at runtime and was
 * already shipping: the worker's copy of the key parser had lost `parseTonic`, so every
 * provider that reports key and mode in separate fields was silently dropped in production
 * while the local copy handled it fine.
 */
const SHARED_FILES = ['nameNormalize.ts', 'keyParse.ts', 'catalogKeyLookup.ts'];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

describe('shared worker sources', () => {
  it.each(SHARED_FILES)('%s is identical in src/services and chordsync-api/src', (file) => {
    const local = readFileSync(resolve(repoRoot, 'src/services', file), 'utf8');
    const worker = readFileSync(resolve(repoRoot, 'chordsync-api/src', file), 'utf8');
    expect(worker, `run scripts/sync-worker-src.sh to re-copy ${file}`).toBe(local);
  });
});
