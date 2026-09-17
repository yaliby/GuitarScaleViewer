export type AudioStep = { notes: number[]; chordIndex?: number };
type PlaybackOptions = {
  bpm: number;
  loop: boolean;
  click: boolean;
  onStep: (step: AudioStep, index: number) => void;
  onEnd: () => void;
};

/** A small look-ahead scheduler. Audio time controls sound; timers only update the UI. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Set<OscillatorNode>();
  private callbacks = new Set<ReturnType<typeof setTimeout>>();
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private volume = 0.55;
  constructor(
    private createContext: () => AudioContext = () => new AudioContext(),
  ) {}

  private async ready(): Promise<AudioContext> {
    if (!this.context) {
      this.context = this.createContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    }
    await this.context.resume();
    return this.context;
  }

  setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.master && this.context)
      this.master.gain.setValueAtTime(this.volume, this.context.currentTime);
  }

  private voice(midi: number, when: number, duration: number, click = false) {
    const ctx = this.context;
    if (!ctx || !this.master || !Number.isFinite(midi)) return;
    const oscillator = ctx.createOscillator(),
      gain = ctx.createGain();
    oscillator.type = click ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(click ? 0.16 : 0.18, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      this.voices.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
  }

  async note(midi: number) {
    const generation = this.generation;
    const ctx = await this.ready();
    if (generation === this.generation)
      this.voice(midi, ctx.currentTime + 0.005, 0.75);
  }

  async chord(notes: readonly number[]) {
    const generation = this.generation;
    const ctx = await this.ready();
    if (generation !== this.generation) return;
    notes.forEach((midi, i) =>
      this.voice(midi, ctx.currentTime + 0.005 + i * 0.018, 1.1),
    );
  }

  async start(steps: AudioStep[], options: PlaybackOptions) {
    this.stop();
    if (!steps.length) {
      options.onEnd();
      return;
    }
    const generation = this.generation;
    const ctx = await this.ready();
    if (generation !== this.generation) return;
    const beatLength = 60 / Math.max(40, Math.min(220, options.bpm));
    let nextAt = ctx.currentTime + 0.05,
      index = 0;
    const later = (when: number, fn: () => void) => {
      const id = setTimeout(
        () => {
          this.callbacks.delete(id);
          if (generation === this.generation) fn();
        },
        Math.max(0, (when - ctx.currentTime) * 1000),
      );
      this.callbacks.add(id);
    };
    const schedule = () => {
      if (generation !== this.generation) return;
      // Recover from a background-tab stall without playing a burst of old beats.
      if (nextAt < ctx.currentTime - 0.1) nextAt = ctx.currentTime + 0.025;
      while (nextAt < ctx.currentTime + 0.12) {
        if (!options.loop && index >= steps.length) {
          if (this.scheduler) clearInterval(this.scheduler);
          this.scheduler = null;
          later(nextAt, options.onEnd);
          return;
        }
        const step = steps[index % steps.length]!;
        const currentIndex = index;
        const noteDuration =
          step.chordIndex === undefined ? beatLength * 0.85 : beatLength * 4;
        step.notes.forEach((midi, i) =>
          this.voice(midi, nextAt + i * 0.012, noteDuration),
        );
        if (options.click)
          this.voice(index % 4 === 0 ? 91 : 84, nextAt, 0.035, true);
        later(nextAt, () => options.onStep(step, currentIndex));
        index++;
        nextAt += beatLength;
      }
    };
    this.scheduler = setInterval(schedule, 25);
    schedule();
  }

  stop() {
    this.generation++;
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
    this.callbacks.forEach(clearTimeout);
    this.callbacks.clear();
    for (const oscillator of this.voices) {
      try {
        oscillator.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.voices.clear();
  }

  dispose() {
    this.stop();
    const context = this.context;
    const master = this.master;
    this.context = null;
    this.master = null;
    master?.disconnect();
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
  }
}
