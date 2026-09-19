import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildMatchKeys, foldName, type MatchKeys } from "./nameNormalize";

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ADMIN_SECRET?: string;
}

const MAX_TITLE_LENGTH = 300;
const MAX_ARTIST_LENGTH = 200;
const MAX_USER_LENGTH = 100;

/**
 * The worker holds a service-role key and honours an admin header, so it must not answer
 * to arbitrary web origins. Only the desktop shell and local dev servers are allowed.
 */
function isAllowedOrigin(origin: string): boolean {
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

function validateText(
  value: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: false, error: `${field} is required` };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string` };
  }
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) {
    return { ok: false, error: `${field} is required` };
  }
  if (collapsed.length > maxLength) {
    return { ok: false, error: `${field} must be at most ${maxLength} characters` };
  }
  return { ok: true, value: collapsed };
}

function normalizeKey(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "key is required" };
  }
  const match = value.trim().replaceAll("♭", "b").replaceAll("♯", "#").match(/^([A-Ga-g])([#b]?)$/);
  if (!match) {
    return { ok: false, error: "key must be a note from A to G with an optional # or b" };
  }
  return { ok: true, value: `${match[1]!.toUpperCase()}${match[2] ?? ""}` };
}

function normalizeMode(value: unknown): { ok: true; value: "major" | "minor" } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "mode is required" };
  }
  const mode = value.trim().toLowerCase();
  if (mode !== "major" && mode !== "minor") {
    return { ok: false, error: "mode must be major or minor" };
  }
  return { ok: true, value: mode };
}

async function parseJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function workerLog(event: string, message: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.info(`[GSV worker] ${event}  ${message}`, detail);
  } else {
    console.info(`[GSV worker] ${event}  ${message}`);
  }
}

/**
 * Rows written before the shared normalizer existed carry a plain lowercase key, rows written
 * since carry the folded one, and a player can announce the same track with any amount of
 * decoration. So every read probes the whole candidate set instead of a single exact key.
 */
function songQuery(supabase: SupabaseClient, keys: MatchKeys) {
  return supabase
    .from("songs")
    .select("*")
    .in("normalized_title", keys.titleKeys)
    .in("normalized_artist", keys.artistKeys);
}

/**
 * `titleKeys` is ordered most-exact-first, so the row matching the earliest candidate is the
 * closest match. Without this a decorated title could pick a different row than the plain one.
 */
function pickClosestSong<T extends { normalized_title?: unknown; normalized_artist?: unknown }>(
  rows: T[] | null,
  keys: MatchKeys,
): T | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  const rank = (row: T) => {
    const titleRank = keys.titleKeys.indexOf(String(row.normalized_title ?? ""));
    const artistRank = keys.artistKeys.indexOf(String(row.normalized_artist ?? ""));
    return (titleRank < 0 ? keys.titleKeys.length : titleRank) +
      (artistRank < 0 ? keys.artistKeys.length : artistRank);
  };
  return [...rows].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function supabaseClient(env: Env): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export default {
  /**
   * Routing happens in `handle`; CORS is applied here in one place so every response
   * — including ones thrown from a route — carries the same origin-checked headers.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    // Only browsers send Origin, so this turns away an unknown web page without
    // touching the database, while native and desktop callers (no Origin) still work.
    if (origin && !isAllowedOrigin(origin)) {
      return Response.json({ error: "origin is not allowed" }, { status: 403 });
    }

    const headers = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const response = await handle(req, env);
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
  {
    // Built on first use, so a request rejected by validation never opens a
    // database connection.
    let client: SupabaseClient | null | undefined;
    const database = (): SupabaseClient | null => {
      if (client === undefined) {
        client = supabaseClient(env);
      }
      return client;
    };
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/lookup-song") {
      const titleField = validateText(url.searchParams.get("title"), "title", MAX_TITLE_LENGTH);
      if (!titleField.ok) {
        workerLog("lookup.skip", "Rejected title", { why: "invalid_title", error: titleField.error });
        return json({ error: titleField.error }, 400);
      }
      const artistField = validateText(url.searchParams.get("artist"), "artist", MAX_ARTIST_LENGTH);
      if (!artistField.ok) {
        workerLog("lookup.skip", "Rejected artist", { why: "invalid_artist", error: artistField.error });
        return json({ error: artistField.error }, 400);
      }
      const title = titleField.value;
      const artist = artistField.value;

      const supabase = database();
      workerLog("lookup.start", `GET /lookup-song "${title}" — ${artist}`, {
        title,
        artist,
        hasSupabase: Boolean(supabase),
      });

      const keys = buildMatchKeys(title, artist);

      if (supabase) {
        try {
          const { data, error } = await songQuery(supabase, keys)
            .eq("verified", true)
            .limit(10);

          const song = error ? null : pickClosestSong(data, keys);
          if (error) {
            workerLog("lookup.db_error", "Supabase verified query failed", {
              error: error.message,
              why: "supabase_error",
            });
            return json({
              found: false,
              incomplete: true,
              source: null,
              song: null,
            });
          }
          if (song) {
            workerLog("lookup.hit", "Verified database hit", {
              source: "verified_db",
              musical_key: (song as { musical_key?: unknown }).musical_key ?? null,
              mode: (song as { mode?: unknown }).mode ?? null,
            });
            return json({
              found: true,
              source: "verified_db",
              sourceLabel: "Verified database",
              song,
            });
          }
          workerLog("lookup.db_miss", "No verified row", { why: "no_verified_row" });
        } catch (error) {
          workerLog("lookup.db_throw", "Supabase threw", {
            error: error instanceof Error ? error.message : String(error),
            why: "supabase_threw",
          });
          return json({
            found: false,
            incomplete: true,
            source: null,
            song: null,
          });
        }
      } else {
        workerLog("lookup.no_db", "Supabase is not configured", { why: "no_supabase" });
      }

      return json({
        found: false,
        source: null,
        song: null,
      });
    }

    if (req.method === "POST" && url.pathname === "/submit-suggestion") {
      const body = await parseJson(req);
      if (!body.ok) {
        return json({ error: "request body must be valid JSON" }, 400);
      }

      // Every field is bounded and normalised before it reaches the table: the key and
      // mode are written verbatim into the catalog, so an unvalidated one poisons later
      // lookups for that song.
      const titleField = validateText(body.value.title, "title", MAX_TITLE_LENGTH);
      if (!titleField.ok) {
        return json({ error: titleField.error }, 400);
      }
      const artistField = validateText(body.value.artist, "artist", MAX_ARTIST_LENGTH);
      if (!artistField.ok) {
        return json({ error: artistField.error }, 400);
      }
      const keyField = normalizeKey(body.value.key);
      if (!keyField.ok) {
        return json({ error: keyField.error }, 400);
      }
      const modeField = normalizeMode(body.value.mode);
      if (!modeField.ok) {
        return json({ error: modeField.error }, 400);
      }
      const userField =
        body.value.user === undefined || body.value.user === null
          ? { ok: true as const, value: "anonymous" }
          : validateText(body.value.user, "user", MAX_USER_LENGTH);
      if (!userField.ok) {
        return json({ error: userField.error }, 400);
      }

      const title = titleField.value;
      const artist = artistField.value;
      const key = keyField.value;
      const mode = modeField.value;
      const user = userField.value;

      const supabase = database();
      if (!supabase) {
        workerLog("suggest.fail", "submit-suggestion rejected — database unavailable", { why: "no_supabase" });
        return json({ error: "database unavailable" }, 503);
      }

      const keys = buildMatchKeys(title, artist);

      // Reads probe every candidate key, so writes must settle on one: the folded form of the
      // cleaned name. Storing the raw announcement here is what filled the table with rows no
      // later lookup could reach.
      const normalizedTitle = foldName(keys.cleanTitle) || keys.titleKeys[0] || "";
      const normalizedArtist = foldName(keys.cleanArtist) || keys.artistKeys[0] || "";

      // Dedupe against rows stored under any older scheme before inserting a new one.
      const { data: existing } = await songQuery(supabase, keys).limit(10);
      let song = pickClosestSong(existing, keys) as { id: string } | null;

      if (!song) {
        const created = await supabase
          .from("songs")
          .insert({
            title: keys.cleanTitle || title,
            artist: keys.cleanArtist || artist,
            normalized_title: normalizedTitle,
            normalized_artist: normalizedArtist,
          })
          .select()
          .single();

        if (created.error) {
          return json({ error: created.error.message }, 500);
        }

        song = created.data;
      }

      if (!song || typeof song.id !== "string") {
        workerLog("suggest.fail", "database returned an invalid song record", { why: "bad_song_row" });
        return json({ error: "database returned an invalid song record" }, 500);
      }

      const result = await supabase.from("key_suggestions").insert({
        song_id: song.id,
        suggested_key: key,
        suggested_mode: mode,
        suggested_by: user,
        status: "pending",
      });

      if (result.error) {
        workerLog("suggest.fail", "key_suggestions insert failed", { error: result.error.message });
        return json({ error: result.error.message }, 500);
      }

      workerLog("suggest.ok", `Stored suggestion ${key} ${mode} for "${title}"`);
      return json({ success: true });
    }

    if (req.method === "GET" && url.pathname === "/admin/pending") {
      const secret = req.headers.get("x-admin-secret");
      if (secret !== env.ADMIN_SECRET) {
        return text("Unauthorized", 401);
      }
      const supabase = database();
      if (!supabase) {
        return json({ error: "database unavailable" }, 503);
      }

      const { data, error } = await supabase
        .from("key_suggestions")
        .select("*")
        .eq("status", "pending");

      if (error) {
        return json({ error: error.message }, 500);
      }

      return json(data);
    }

    /**
     * One-time (re-runnable) backfill: rewrites `normalized_title` / `normalized_artist` of
     * every row with the same normalizer the lookup uses. Rows written under the old
     * lowercase-only scheme are reachable today only because reads probe that space too;
     * running this collapses everything into one space so the probe set stops growing.
     */
    if (req.method === "POST" && url.pathname === "/admin/renormalize") {
      const secret = req.headers.get("x-admin-secret");
      if (secret !== env.ADMIN_SECRET) {
        return text("Unauthorized", 401);
      }
      const supabase = database();
      if (!supabase) {
        return json({ error: "database unavailable" }, 503);
      }
      const dryRun = url.searchParams.get("apply") !== "true";

      const { data, error } = await supabase.from("songs").select("id, title, artist, normalized_title, normalized_artist");
      if (error) {
        return json({ error: error.message }, 500);
      }

      const rows = (data ?? []) as Array<{
        id: string;
        title: string | null;
        artist: string | null;
        normalized_title: string | null;
        normalized_artist: string | null;
      }>;

      const seen = new Map<string, string>();
      const changes: Array<{ id: string; normalized_title: string; normalized_artist: string }> = [];
      const collisions: Array<{ id: string; conflictsWith: string; key: string }> = [];

      for (const row of rows) {
        const keys = buildMatchKeys(row.title ?? "", row.artist ?? "");
        const normalizedTitle = foldName(keys.cleanTitle) || row.normalized_title || "";
        const normalizedArtist = foldName(keys.cleanArtist) || row.normalized_artist || "";
        if (!normalizedTitle || !normalizedArtist) {
          continue;
        }
        const composite = `${normalizedTitle}|${normalizedArtist}`;
        const owner = seen.get(composite);
        if (owner && owner !== row.id) {
          // Two rows fold together. Merging them is a judgement call about which key is right,
          // so report and skip rather than silently dropping one.
          collisions.push({ id: row.id, conflictsWith: owner, key: composite });
          continue;
        }
        seen.set(composite, row.id);
        if (normalizedTitle !== row.normalized_title || normalizedArtist !== row.normalized_artist) {
          changes.push({ id: row.id, normalized_title: normalizedTitle, normalized_artist: normalizedArtist });
        }
      }

      if (dryRun) {
        return json({ dryRun: true, scanned: rows.length, wouldUpdate: changes.length, collisions });
      }

      let updated = 0;
      for (const change of changes) {
        const result = await supabase
          .from("songs")
          .update({ normalized_title: change.normalized_title, normalized_artist: change.normalized_artist })
          .eq("id", change.id);
        if (result.error) {
          return json({ error: result.error.message, updated, collisions }, 500);
        }
        updated += 1;
      }

      return json({ dryRun: false, scanned: rows.length, updated, collisions });
    }

    return text("Not Found", 404);
  }
}
