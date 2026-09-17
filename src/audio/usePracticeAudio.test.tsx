import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePracticeAudio } from "./usePracticeAudio";

function audioContext() {
  const frequencies: number[] = [];
  const parameter = {
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  const close = vi.fn(async () => {});
  const context = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: vi.fn(async () => {}),
    close,
    createGain: () => ({
      gain: { ...parameter },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createOscillator: () => ({
      frequency: { setValueAtTime: (value: number) => frequencies.push(value) },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
      type: "sine",
    }),
  };
  return { context: context as unknown as AudioContext, frequencies, close };
}

afterEach(() => vi.unstubAllGlobals());

describe("usePracticeAudio resource lifecycle", () => {
  it("remains usable after StrictMode effect replay and closes its context on unmount", async () => {
    const fake = audioContext();
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function AudioContextMock() {
        return fake.context;
      }),
    );
    const { result, unmount } = renderHook(() => usePracticeAudio(0.55), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });

    await act(async () => result.current.audition([69]));
    expect(fake.frequencies).toContain(440);
    unmount();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
