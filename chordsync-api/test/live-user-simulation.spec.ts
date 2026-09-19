import { describe, expect, it } from "vitest";
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
      incomplete?: boolean;
      song: { musical_key: string; mode: string; verified: boolean; title: string; artist: string } | null;
    },
  };
}

describe("live user simulation against the verified lookup", () => {
  it("returns a clean miss for a popular track that is not in the verified table", async () => {
    const result = await lookupViaWorker("Blinding Lights", "The Weeknd");
    expect(result.status).toBe(200);
    expect(result.body.found).toBe(false);
    expect(result.body.song).toBeNull();
  }, 30_000);

  /**
   * The shape a YouTube/browser session actually announces. Both announcements must behave
   * the same against the verified table — neither may fall through to a catalog guess.
   */
  it("resolves the same answer from a noisy YouTube-style announcement as from clean metadata", async () => {
    const clean = await lookupViaWorker("Numb", "Linkin Park");
    const noisy = await lookupViaWorker(
      "Linkin Park - Numb (Official Music Video) [4K UPGRADE]",
      "Linkin Park - Topic",
    );
    expect(noisy.body.found).toBe(clean.body.found);
    expect(noisy.body.song?.musical_key).toBe(clean.body.song?.musical_key);
    expect(noisy.body.song?.mode).toBe(clean.body.song?.mode);
  }, 45_000);

  it("returns a clean miss for nonsense metadata so the local engine would run", async () => {
    const result = await lookupViaWorker("zzqwxkj live-sim", "no-such-artist-xyz");
    expect(result.status).toBe(200);
    expect(result.body.found).toBe(false);
    expect(result.body.song).toBeNull();
  }, 30_000);
});
