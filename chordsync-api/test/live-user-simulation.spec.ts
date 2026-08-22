import { describe, expect, it } from "vitest";
import { lookupKeyFromCatalogs } from "../src/catalogKeyLookup";
import worker from "../src/index";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function lookupViaWorker(title: string, artist: string) {
  const request = new IncomingRequest(
    `http://example.com/lookup-song?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    body: (await response.json()) as {
      found: boolean;
      source: string | null;
      catalogsTried?: boolean;
      song: { musical_key: string; mode: string; verified: boolean; title: string; artist: string } | null;
    },
  };
}

describe("live user simulation against public catalogs", () => {
  it("finds a catalog key for Blinding Lights after DB miss", async () => {
    const result = await lookupViaWorker("Blinding Lights", "The Weeknd");
    expect(result.status).toBe(200);
    expect(result.body.found).toBe(true);
    expect(result.body.song?.verified).toBe(false);
    expect(result.body.song?.musical_key).toMatch(/^[A-G]#?$/);
    expect(["major", "minor"]).toContain(result.body.song?.mode);
    expect(["reccobeats", "musiciwant", "freqblog", "getsongbpm"]).toContain(result.body.source);
  }, 30_000);

  it("finds a catalog key for Numb / Linkin Park (UI mock-track default)", async () => {
    const hit = await lookupKeyFromCatalogs("Numb", "Linkin Park");
    expect(hit).not.toBeNull();
    expect(hit?.key).toMatch(/^[A-G]#?$/);
    expect(["major", "minor"]).toContain(hit?.mode);
    expect(["reccobeats", "musiciwant"]).toContain(hit?.provider);
  }, 30_000);

  it("finds a catalog key for Black / Pearl Jam", async () => {
    const hit = await lookupKeyFromCatalogs("Black", "Pearl Jam");
    expect(hit).not.toBeNull();
    expect(hit?.key).toBeTruthy();
  }, 30_000);

  it("returns a clean miss for nonsense metadata so the local engine would run", async () => {
    const result = await lookupViaWorker("zzqwxkj live-sim", "no-such-artist-xyz");
    expect(result.status).toBe(200);
    expect(result.body.found).toBe(false);
    expect(result.body.catalogsTried).toBe(true);
    expect(result.body.song).toBeNull();
  }, 30_000);
});
