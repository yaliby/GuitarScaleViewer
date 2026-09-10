import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { catalogProviderLabel, lookupKeyFromCatalogs } from "./catalogKeyLookup";

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

function normalize(v: string) {
  return v.toLowerCase().trim().replace(/\s+/g, " ");
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

      if (supabase) {
        try {
          const { data, error } = await supabase
            .from("songs")
            .select("*")
            .eq("normalized_title", normalize(title))
            .eq("normalized_artist", normalize(artist))
            .eq("verified", true)
            .maybeSingle();

          if (!error && data) {
            return json({
              found: true,
              catalogsTried: false,
              source: "verified_db",
              song: data,
            });
          }
        } catch {
          // Broken DB hosting should not skip catalog fallbacks.
        }
      }

      const catalog = await lookupKeyFromCatalogs(title, artist, {
        freqblogApiKey: env.FREQBLOG_API_KEY,
        getsongbpmApiKey: env.GETSONGBPM_API_KEY,
      });

      if (catalog) {
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

      return json({
        found: false,
        catalogsTried: true,
        source: null,
        song: null,
      });
    }

    if (req.method === "POST" && url.pathname === "/submit-suggestion") {
      if (!supabase) {
        return json({ error: "database unavailable" }, 503);
      }

      const body = (await req.json()) as any;

      let title = body.title;
      let artist = body.artist;
      let key = body.key;
      let mode = body.mode;
      let user = body.user || "anonymous";

      let normalizedTitle = normalize(title);
      let normalizedArtist = normalize(artist);

      let { data: song } = await supabase
        .from("songs")
        .select("id")
        .eq("normalized_title", normalizedTitle)
        .eq("normalized_artist", normalizedArtist)
        .maybeSingle();

      if (!song) {
        const created = await supabase
          .from("songs")
          .insert({
            title,
            artist,
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
        return json({ error: result.error.message }, 500);
      }

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

    return text("Not Found", 404);
  },
};
