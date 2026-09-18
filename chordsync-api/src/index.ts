import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { catalogProviderLabel, lookupKeyFromCatalogs } from "./catalogKeyLookup";
import { buildMatchKeys, foldName, type MatchKeys } from "./nameNormalize";

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ADMIN_SECRET?: string;
  FREQBLOG_API_KEY?: string;
  GETSONGBPM_API_KEY?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: CORS });
}

function workerLog(event: string, message: string, detail?: Record<string, unknown>): void {
  if (detail) {
    console.info(`[GSV worker] ${event}  ${message}`, detail);
  } else {
    console.info(`[GSV worker] ${event}  ${message}`);
  }
}

function catalogOnTrace(event: string, message: string, detail?: Record<string, unknown>): void {
  workerLog(`catalog.${event}`, message, detail);
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
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const supabase = supabaseClient(env);
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/lookup-song") {
      const title = url.searchParams.get("title") || "";
      const artist = url.searchParams.get("artist") || "";
      workerLog("lookup.start", `GET /lookup-song "${title}" — ${artist}`, {
        title,
        artist,
        hasSupabase: Boolean(supabase),
      });

      if (!title.trim() || !artist.trim()) {
        workerLog("lookup.skip", "Empty title or artist — no lookup", { why: "empty_metadata" });
        return json({ found: false, catalogsTried: false, source: null, song: null });
      }

      const keys = buildMatchKeys(title, artist);

      if (supabase) {
        try {
          const { data, error } = await songQuery(supabase, keys)
            .eq("verified", true)
            .limit(10);

          const song = error ? null : pickClosestSong(data, keys);
          if (error) {
            workerLog("lookup.db_error", "Supabase verified query failed — falling through to catalogs", {
              error: error.message,
              why: "supabase_error",
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
              catalogsTried: false,
              source: "verified_db",
              song,
            });
          }
          workerLog("lookup.db_miss", "No verified row — walking catalogs", { why: "no_verified_row" });
        } catch (error) {
          workerLog("lookup.db_throw", "Supabase threw — falling through to catalogs", {
            error: error instanceof Error ? error.message : String(error),
            why: "supabase_threw",
          });
          // Broken DB hosting should not skip catalog fallbacks.
        }
      } else {
        workerLog("lookup.no_db", "Supabase is not configured — catalogs only", { why: "no_supabase" });
      }

      const { hit: catalog, incomplete } = await lookupKeyFromCatalogs(keys.cleanTitle, keys.cleanArtist, {
        freqblogApiKey: env.FREQBLOG_API_KEY,
        getsongbpmApiKey: env.GETSONGBPM_API_KEY,
        onTrace: catalogOnTrace,
      });

      if (catalog) {
        workerLog("lookup.hit", `Catalog hit via ${catalog.provider}: ${catalog.key} ${catalog.mode}`, {
          source: catalog.provider,
          key: catalog.key,
          mode: catalog.mode,
        });
        return json({
          found: true,
          catalogsTried: true,
          source: catalog.provider,
          sourceLabel: catalogProviderLabel(catalog.provider),
          song: {
            id: `${catalog.provider}:${catalog.remoteId}`,
            title: catalog.title,
            artist: catalog.artist,
            musical_key: catalog.key,
            mode: catalog.mode,
            verified: false,
          },
        });
      }

      // A throttled or unreachable catalog is not an answer about this song. Reporting
      // `catalogsTried: false` lets the client retry from its own network instead of caching
      // a miss it would then sit on for minutes.
      workerLog(
        incomplete ? "lookup.incomplete" : "lookup.miss",
        incomplete
          ? "Catalogs never answered — telling the client not to cache a miss"
          : "Catalogs answered and none had a key",
        { incomplete, catalogsTried: !incomplete },
      );
      return json({
        found: false,
        catalogsTried: !incomplete,
        source: null,
        song: null,
      });
    }

    if (req.method === "POST" && url.pathname === "/submit-suggestion") {
      if (!supabase) {
        workerLog("suggest.fail", "submit-suggestion rejected — database unavailable", { why: "no_supabase" });
        return json({ error: "database unavailable" }, 503);
      }

      const body = (await req.json()) as any;

      let title = body.title;
      let artist = body.artist;
      let key = body.key;
      let mode = body.mode;
      let user = body.user || "anonymous";

      if (typeof title !== "string" || typeof artist !== "string" || !title.trim() || !artist.trim()) {
        return json({ error: "title and artist are required" }, 400);
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

      const result = await supabase.from("key_suggestions").insert({
        song_id: song!.id,
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
  },
};
