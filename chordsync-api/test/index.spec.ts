import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { lookupKeyFromCatalogs } from "../src/catalogKeyLookup";
import { parseKeyAndMode, parseSpotifyStyleKey } from "../src/keyParse";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("key parsing", () => {
  it("parses catalog key strings", () => {
    expect(parseKeyAndMode("C#-Minor")).toEqual({ key: "C#", mode: "minor" });
    expect(parseKeyAndMode("E minor")).toEqual({ key: "E", mode: "minor" });
    expect(parseKeyAndMode("D major")).toEqual({ key: "D", mode: "major" });
    expect(parseKeyAndMode("F#m")).toEqual({ key: "F#", mode: "minor" });
  });

  it("parses ReccoBeats/Spotify style integers", () => {
    expect(parseSpotifyStyleKey(4, 0)).toEqual({ key: "E", mode: "minor" });
    expect(parseSpotifyStyleKey(1, 1)).toEqual({ key: "C#", mode: "major" });
  });
});

describe("catalog fallbacks", () => {
  it("uses ReccoBeats when title and artist match", async () => {
    const hit = await lookupKeyFromCatalogs("Blinding Lights", "The Weeknd", {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/track/search")) {
          return jsonResponse({
            content: [
              {
                id: "recco-1",
                trackTitle: "Blinding Lights",
                popularity: 87,
                href: "https://open.spotify.com/track/abc123",
                artists: [{ name: "The Weeknd" }],
              },
            ],
          });
        }
        if (url.includes("/v1/audio-features")) {
          return jsonResponse({ content: [{ key: 1, mode: 0 }] });
        }
        return jsonResponse({ error: "unexpected " + url }, 500);
      },
    });
    expect(hit).toMatchObject({
      provider: "reccobeats",
      key: "C#",
      mode: "minor",
    });
  });

  it("falls through to MusicIWant then ReccoBeats features", async () => {
    const hit = await lookupKeyFromCatalogs("Wonderwall", "Oasis", {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api.reccobeats.com/v1/track/search")) {
          return jsonResponse({ content: [] });
        }
        if (url.includes("musiciwant.com/api/v1/song")) {
          return jsonResponse({
            found: true,
            song: { title: "Wonderwall", artist: "Oasis", spotify_id: "spot-1" },
          });
        }
        if (url.includes("/v1/audio-features")) {
          return jsonResponse({ content: [{ key: 2, mode: 1 }] });
        }
        return jsonResponse({ error: "unexpected " + url }, 500);
      },
    });
    expect(hit).toMatchObject({
      provider: "musiciwant",
      key: "D",
      mode: "major",
      remoteId: "spot-1",
    });
  });

  it("uses FreqBlog when an API key is present and earlier catalogs miss", async () => {
    const hit = await lookupKeyFromCatalogs("Black", "Pearl Jam", {
      freqblogApiKey: "fb_test",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("api.reccobeats.com") || url.includes("musiciwant.com")) {
          return jsonResponse({ found: false, content: [] });
        }
        if (url.includes("api.freqblog.com/lookup")) {
          const headers = new Headers(init?.headers);
          expect(headers.get("X-API-Key")).toBe("fb_test");
          return jsonResponse({
            track_name: "Black",
            artist_name: "Pearl Jam",
            key: "E-Minor",
            isrc: "US123",
          });
        }
        return jsonResponse({ error: "unexpected " + url }, 500);
      },
    });
    expect(hit).toMatchObject({ provider: "freqblog", key: "E", mode: "minor" });
  });

  it("uses GetSongBPM last when its key is configured", async () => {
    const hit = await lookupKeyFromCatalogs("Black", "Pearl Jam", {
      getsongbpmApiKey: "gsb_test",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("getsongbpm.com")) {
          return jsonResponse({
            search: [
              {
                id: "song-1",
                song_title: "Black",
                artist: { name: "Pearl Jam" },
                key_of: "E",
                mode: "minor",
              },
            ],
          });
        }
        return jsonResponse({ found: false, content: [] });
      },
    });
    expect(hit).toMatchObject({ provider: "getsongbpm", key: "E", mode: "minor" });
  });
});

describe("lookup-song worker", () => {
  it("returns a catalog hit when the verified database is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/track/search")) {
        return jsonResponse({
          content: [
            {
              id: "recco-db-miss",
              trackTitle: "Black",
              popularity: 70,
              href: "https://open.spotify.com/track/black1",
              artists: [{ name: "Pearl Jam" }],
            },
          ],
        });
      }
      if (url.includes("/v1/audio-features")) {
        return jsonResponse({ content: [{ key: 4, mode: 0 }] });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const request = new IncomingRequest(
        "http://example.com/lookup-song?title=Black&artist=Pearl%20Jam",
      );
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        found: boolean;
        source: string;
        catalogsTried: boolean;
        song: { musical_key: string; mode: string; verified: boolean };
      };
      expect(body.found).toBe(true);
      expect(body.source).toBe("reccobeats");
      expect(body.catalogsTried).toBe(true);
      expect(body.song).toMatchObject({
        musical_key: "E",
        mode: "minor",
        verified: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a catalog miss instead of 500 when nothing matches", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ content: [], found: false })) as typeof fetch;
    try {
      const request = new IncomingRequest(
        "http://example.com/lookup-song?title=Unknown&artist=Nobody",
      );
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        found: false,
        catalogsTried: true,
        song: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
