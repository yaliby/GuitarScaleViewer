import { createClient } from '@supabase/supabase-js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_SECRET: string;
}

const MAX_TITLE_LENGTH = 300;
const MAX_ARTIST_LENGTH = 200;
const MAX_USER_LENGTH = 100;

function normalize(value: string) {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !isAllowedOrigin(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function validateText(
  value: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} is required` };
  }
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return { ok: false, error: `${field} is required` };
  }
  if (collapsed.length > maxLength) {
    return { ok: false, error: `${field} must be at most ${maxLength} characters` };
  }
  return { ok: true, value: collapsed };
}

function normalizeKey(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'key is required' };
  }
  const match = value.trim().replaceAll('♭', 'b').replaceAll('♯', '#').match(/^([A-Ga-g])([#b]?)$/);
  if (!match) {
    return { ok: false, error: 'key must be a note from A to G with an optional # or b' };
  }
  return { ok: true, value: `${match[1]!.toUpperCase()}${match[2] ?? ''}` };
}

function normalizeMode(value: unknown): { ok: true; value: 'major' | 'minor' } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'mode is required' };
  }
  const mode = value.trim().toLowerCase();
  if (mode !== 'major' && mode !== 'minor') {
    return { ok: false, error: 'mode must be major or minor' };
  }
  return { ok: true, value: mode };
}

function databaseFor(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

async function parseJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    if (origin && !isAllowedOrigin(origin)) {
      return json({ error: 'origin is not allowed' }, 403, null);
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/lookup-song') {
      const title = validateText(url.searchParams.get('title'), 'title', MAX_TITLE_LENGTH);
      if (!title.ok) {
        return json({ error: title.error }, 400, origin);
      }
      const artist = validateText(url.searchParams.get('artist'), 'artist', MAX_ARTIST_LENGTH);
      if (!artist.ok) {
        return json({ error: artist.error }, 400, origin);
      }

      const { data, error } = await databaseFor(env)
        .from('songs')
        .select('id,title,artist,musical_key,mode,verified')
        .eq('normalized_title', normalize(title.value))
        .eq('normalized_artist', normalize(artist.value))
        .eq('verified', true)
        .maybeSingle();

      if (error) {
        return json({ error: error.message }, 500, origin);
      }
      return json({ found: Boolean(data), song: data }, 200, origin);
    }

    if (req.method === 'POST' && url.pathname === '/submit-suggestion') {
      const parsed = await parseJson(req);
      if (!parsed.ok) {
        return json({ error: 'request body must be valid JSON' }, 400, origin);
      }
      const title = validateText(parsed.value.title, 'title', MAX_TITLE_LENGTH);
      if (!title.ok) {
        return json({ error: title.error }, 400, origin);
      }
      const artist = validateText(parsed.value.artist, 'artist', MAX_ARTIST_LENGTH);
      if (!artist.ok) {
        return json({ error: artist.error }, 400, origin);
      }
      const key = normalizeKey(parsed.value.key);
      if (!key.ok) {
        return json({ error: key.error }, 400, origin);
      }
      const mode = normalizeMode(parsed.value.mode);
      if (!mode.ok) {
        return json({ error: mode.error }, 400, origin);
      }

      let user = 'anonymous';
      if (parsed.value.user !== undefined) {
        if (typeof parsed.value.user !== 'string') {
          return json({ error: 'user must be a string' }, 400, origin);
        }
        user = parsed.value.user.trim() || 'anonymous';
        if (user.length > MAX_USER_LENGTH) {
          return json({ error: `user must be at most ${MAX_USER_LENGTH} characters` }, 400, origin);
        }
      }

      const supabase = databaseFor(env);
      const normalizedTitle = normalize(title.value);
      const normalizedArtist = normalize(artist.value);
      const existing = await supabase
        .from('songs')
        .select('id')
        .eq('normalized_title', normalizedTitle)
        .eq('normalized_artist', normalizedArtist)
        .maybeSingle();

      if (existing.error) {
        return json({ error: existing.error.message }, 500, origin);
      }

      let song = existing.data;
      if (!song) {
        const created = await supabase
          .from('songs')
          .insert({
            title: title.value,
            artist: artist.value,
            normalized_title: normalizedTitle,
            normalized_artist: normalizedArtist,
          })
          .select('id')
          .single();

        if (created.error) {
          return json({ error: created.error.message }, 500, origin);
        }
        song = created.data;
      }

      if (!song || typeof song.id !== 'string') {
        return json({ error: 'database returned an invalid song record' }, 500, origin);
      }

      const result = await supabase.from('key_suggestions').insert({
        song_id: song.id,
        suggested_key: key.value,
        suggested_mode: mode.value,
        suggested_by: user,
        status: 'pending',
      });

      if (result.error) {
        return json({ error: result.error.message }, 500, origin);
      }
      return json({ success: true }, 200, origin);
    }

    if (req.method === 'GET' && url.pathname === '/admin/pending') {
      if (req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorized' }, 401, origin);
      }
      const { data, error } = await databaseFor(env)
        .from('key_suggestions')
        .select('*')
        .eq('status', 'pending');
      if (error) {
        return json({ error: error.message }, 500, origin);
      }
      return json(data, 200, origin);
    }

    return json({ error: 'Not Found' }, 404, origin);
  },
};
