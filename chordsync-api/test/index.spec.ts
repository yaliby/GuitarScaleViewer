import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryResult = { data: unknown; error: { message: string } | null };

const database = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; operation: string; value?: unknown }>,
  songLookup: { data: null, error: null } as QueryResult,
  songCreate: { data: { id: 'created-song' }, error: null } as QueryResult,
  suggestionInsert: { data: null, error: null } as QueryResult,
  pending: { data: [], error: null } as QueryResult,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      let operation = '';
      const builder = {
        select() {
          operation = operation || 'select';
          return builder;
        },
        eq() {
          return builder;
        },
        insert(value: unknown) {
          operation = 'insert';
          database.calls.push({ table, operation, value });
          return builder;
        },
        maybeSingle() {
          database.calls.push({ table, operation });
          return Promise.resolve(database.songLookup);
        },
        single() {
          return Promise.resolve(database.songCreate);
        },
        then(resolve: (result: QueryResult) => unknown, reject: (error: unknown) => unknown) {
          const result = table === 'key_suggestions' && operation === 'insert'
            ? database.suggestionInsert
            : database.pending;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  })),
}));

import { createClient } from '@supabase/supabase-js';
import worker from '../src/index';

const TEST_ENV = {
  SUPABASE_URL: 'https://database.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  ADMIN_SECRET: 'admin-test',
};

function request(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.test${path}`, init), TEST_ENV);
}

beforeEach(() => {
  database.calls.length = 0;
  database.songLookup = { data: null, error: null };
  database.songCreate = { data: { id: 'created-song' }, error: null };
  database.suggestionInsert = { data: null, error: null };
  database.pending = { data: [], error: null };
  vi.mocked(createClient).mockClear();
});

describe('CORS', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:1420', 'http://tauri.localhost'])(
    'answers preflight for controlled app origin %s before database access',
    async (origin) => {
      const response = await request('/submit-suggestion', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it('rejects an unrecognized browser origin before database access', async () => {
    const response = await request('/lookup-song?title=Song&artist=Artist', {
      headers: { Origin: 'https://attacker.example' },
    });

    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('GET /lookup-song', () => {
  it('returns a verified database hit with CORS headers', async () => {
    database.songLookup = {
      data: {
        id: 'song-1',
        title: 'Blue in Green',
        artist: 'Miles Davis',
        musical_key: 'Bb',
        mode: 'major',
        verified: true,
      },
      error: null,
    };

    const response = await request('/lookup-song?title=Blue%20in%20Green&artist=Miles%20Davis', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(await response.json()).toMatchObject({ found: true, song: { musical_key: 'Bb' } });
  });

  it('rejects missing query fields before database access', async () => {
    const response = await request('/lookup-song?title=Song');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'artist is required' });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('POST /submit-suggestion', () => {
  it('returns a controlled error for an empty body before database access', async () => {
    const response = await request('/submit-suggestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'title is required' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    [
      { title: 'Song', artist: 'Artist', key: 'H', mode: 'major' },
      'key must be a note from A to G with an optional # or b',
    ],
    [{ title: 'Song', artist: 'Artist', key: 'Bb', mode: 'dorian' }, 'mode must be major or minor'],
    [{ title: 'Song', artist: 'Artist', key: 'C', mode: 'major', user: 42 }, 'user must be a string'],
  ])('validates malformed suggestion fields before database access', async (body, message) => {
    const response = await request('/submit-suggestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns a controlled error for invalid JSON', async () => {
    const response = await request('/submit-suggestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'request body must be valid JSON' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('normalizes a valid suggestion and returns success', async () => {
    const response = await request('/submit-suggestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://tauri.localhost' },
      body: JSON.stringify({
        title: '  Blue   in Green ',
        artist: ' Miles Davis ',
        key: 'bb',
        mode: 'MAJOR',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(database.calls).toContainEqual({
      table: 'key_suggestions',
      operation: 'insert',
      value: {
        song_id: 'created-song',
        suggested_key: 'Bb',
        suggested_mode: 'major',
        suggested_by: 'anonymous',
        status: 'pending',
      },
    });
  });
});
