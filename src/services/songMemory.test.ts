// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmedMode, rememberScale, songMemoryId } from "./songMemory";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("song memory", () => {
  it("folds a title the same way the sidecar does", () => {
    expect(songMemoryId("  Numb ", "Linkin Park")).toBe("numb\u001flinkin park");
    expect(songMemoryId("   ", "Someone")).toBe("");
  });

  it("keeps a marked scale for the next play of that song", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => null })),
    );
    const saved = await rememberScale({
      title: "Numb",
      artist: "Linkin Park",
      key: "f#",
      mode: "minor",
    });
    expect(saved).toBe(true);
    const raw = JSON.parse(localStorage.getItem("gsv.song-memory.scales.v1") ?? "{}");
    expect(raw["numb\u001flinkin park"]).toMatchObject({ key: "F#", mode: "minor" });
    expect(confirmedMode("pentatonic-minor")).toBe("minor");
    expect(confirmedMode("dorian")).toBeNull();
  });

  it("refuses a scale that is not a key", async () => {
    const saved = await rememberScale({
      title: "Numb",
      artist: "Linkin Park",
      key: "H",
      mode: "major",
    });
    expect(saved).toBe(false);
    expect(localStorage.getItem("gsv.song-memory.scales.v1")).toBeNull();
  });
});
