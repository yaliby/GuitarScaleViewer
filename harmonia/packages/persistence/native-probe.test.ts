// @ts-nocheck
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readNativeRecords } from './native-probe.mjs';

it('reads native saved JSON while excluding quarantined rows without an analysis identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harmonia-probe-test-'));
  const file = join(directory, 'library.db');
  try {
    const database = new DatabaseSync(file);
    database.exec('CREATE TABLE saved_tracks (analysis_id TEXT, record_json TEXT)');
    const insert = database.prepare('INSERT INTO saved_tracks VALUES (?, ?)');
    insert.run(
      'analysis-1',
      JSON.stringify({ analysis: { id: 'analysis-1' }, corrections: ['kept'] }),
    );
    insert.run(null, '{corrupt');
    database.close();
    expect(readNativeRecords(file)).toEqual([
      { analysis: { id: 'analysis-1' }, corrections: ['kept'] },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not create a database when the requested native library does not exist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harmonia-probe-test-'));
  const file = join(directory, 'missing.db');
  try {
    expect(() => readNativeRecords(file)).toThrow();
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
