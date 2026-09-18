import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine";

function context() {
  const frequencies: number[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const rampEnds: number[] = [];
  const param = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn((_value: number, when: number) =>
      rampEnds.push(when),
    ),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    value: 1,
  };
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createGain: () => ({
      gain: { ...param },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createOscillator: () => {
      const stop = vi.fn();
      stops.push(stop);
      return {
        frequency: { setValueAtTime: (n: number) => frequencies.push(n) },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop,
        onended: null,
        type: "sine",
      };
    },
  };
  return {
    ctx: ctx as unknown as AudioContext,
    frequencies,
    stops,
    rampEnds,
    close: ctx.close,
  };
}
describe("practice audio resource ownership", () => {
  it("sounds concert A at 440 Hz and stops every active voice", async () => {
    const fake = context();
    const engine = new AudioEngine(() => fake.ctx);
    await engine.note(69);
    expect(fake.frequencies).toContain(440);
    engine.stop();
    expect(fake.stops.every((stop) => stop.mock.calls.length >= 2)).toBe(true);
  });
  it("does not start playback after stop cancels a pending audio resume", async () => {
    const fake = context();
    let resume: (() => void) | undefined;
    fake.ctx.resume = () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      });
    const engine = new AudioEngine(() => fake.ctx);
    const started = engine.start([{ notes: [69] }], {
      bpm: 80,
      loop: false,
      click: false,
      onStep: vi.fn(),
      onEnd: vi.fn(),
    });
    engine.stop();
    resume!();
    await started;
    expect(fake.frequencies).toEqual([]);
  });
  it("sustains a progression chord through its four-beat slot", async () => {
    const fake = context();
    const engine = new AudioEngine(() => fake.ctx);
    await engine.start(
      [
        { notes: [60], chordIndex: 0 },
        { notes: [], chordIndex: 0 },
        { notes: [], chordIndex: 0 },
        { notes: [], chordIndex: 0 },
      ],
      { bpm: 40, loop: false, click: false, onStep: vi.fn(), onEnd: vi.fn() },
    );
    expect(fake.rampEnds).toContainEqual(expect.closeTo(6.05, 5));
    engine.stop();
  });
  it("closes the owned audio context when disposed", async () => {
    const fake = context();
    const engine = new AudioEngine(() => fake.ctx);
    await engine.note(69);
    engine.dispose();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
