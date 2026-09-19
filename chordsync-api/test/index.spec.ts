import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
    expect(parseSpotifyStyleKey(1, 1)).toEqual({ key: "Db", mode: "major" });
  });
});

describe("lookup-song worker", () => {
  it("returns a verified miss when the database is unavailable, without calling catalogs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("no catalog call expected");
    }) as typeof fetch;

    try {
      const request = new IncomingRequest(
        "http://example.com/lookup-song?title=Black&artist=Pearl%20Jam",
      );
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        found: false,
        song: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a miss instead of 500 when nothing matches", async () => {
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
        song: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an empty title or artist without touching the database", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("no catalog call expected");
    }) as typeof fetch;
    try {
      const request = new IncomingRequest("http://example.com/lookup-song?title=&artist=Nobody");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "title is required" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
