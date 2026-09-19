#!/usr/bin/env node
/**
 * Regenerates `src/data/verifiedKeys.json` from the verified rows in Supabase.
 *
 * The database is where a person enters and reviews keys; the bundled JSON is how the app reads
 * them with no network in the way. This script is the seam between the two, and it is the only
 * supported way to move rows across: hand-editing the JSON is allowed (the loader parses rather
 * than trusts it), but the next export overwrites it.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/export-verified-keys.mjs
 *
 * The service-role key is read from the environment and never written to the output. Run this
 * from a shell, not from the app.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/verifiedKeys.json');
const PAGE_SIZE = 1000;

const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.');
  process.exit(1);
}

/** PostgREST caps a response; page until a short page comes back. */
async function fetchAllVerified() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const endpoint = new URL(`${url}/rest/v1/songs`);
    endpoint.searchParams.set('select', 'title,artist,musical_key,mode');
    endpoint.searchParams.set('verified', 'is.true');
    endpoint.searchParams.set('musical_key', 'not.is.null');
    endpoint.searchParams.set('mode', 'not.is.null');
    endpoint.searchParams.set('order', 'artist.asc,title.asc');

    const res = await fetch(endpoint, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Supabase returned HTTP ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    if (!Array.isArray(page)) {
      throw new Error('Supabase returned a non-array body');
    }
    rows.push(...page);
    if (page.length < PAGE_SIZE) {
      return rows;
    }
  }
}

const rows = await fetchAllVerified();
const entries = rows
  .filter((row) => row?.title && row?.artist && row?.musical_key && row?.mode)
  .map((row) => ({
    title: String(row.title),
    artist: String(row.artist),
    key: String(row.musical_key),
    mode: String(row.mode),
  }));

let previous = 0;
try {
  previous = JSON.parse(readFileSync(OUT, 'utf8')).entries?.length ?? 0;
} catch {
  // First run, or the file was removed. Either way the count below is just for the operator.
}

writeFileSync(
  OUT,
  `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
);

console.log(`Wrote ${entries.length} verified keys to src/data/verifiedKeys.json (was ${previous}).`);
if (entries.length < previous) {
  console.warn('The table shrank. Check that rows were not un-verified by accident before committing.');
}
