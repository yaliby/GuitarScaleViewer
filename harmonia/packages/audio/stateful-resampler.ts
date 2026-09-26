// @ts-nocheck
/** Fixed 48k→22.05k polyphase windowed-sinc FIR. Future support is explicit. */
export const RESAMPLER_LOOKAHEAD = 64 / 48000;
const RADIUS = 64;
const PHASES = 147;
const STEP = 320;
const cutoff = (0.45 * 22050) / 48000;
const coefficients = Array.from({ length: PHASES }, (_, phase) => {
  const fraction = phase / PHASES;
  const taps = Float64Array.from({ length: 129 }, (_, i) => {
    const distance = i - RADIUS - fraction;
    if (Math.abs(distance) > RADIUS) return 0;
    const window =
      0.42 +
      0.5 * Math.cos((Math.PI * distance) / RADIUS) +
      0.08 * Math.cos((2 * Math.PI * distance) / RADIUS);
    return (
      (distance === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance)) * window
    );
  });
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((v) => v / sum);
});

export class StatefulResampler {
  private readonly ring = new Float32Array(2048);
  private received = 0;
  private output = 0;
  get retainedFrames() {
    return Math.min(this.received, 129);
  }
  push(samples: Float32Array): Float32Array {
    if (
      !(samples instanceof Float32Array) ||
      !samples.length ||
      samples.length > 960 ||
      samples.some((v) => !Number.isFinite(v))
    )
      throw new Error('Invalid resampler PCM block');
    for (const sample of samples) this.ring[this.received++ % this.ring.length] = sample;
    const values = new Float32Array(442);
    let length = 0;
    while (true) {
      const numerator = this.output * STEP;
      const center = Math.floor(numerator / PHASES);
      if (center + RADIUS >= this.received) break;
      const taps = coefficients[numerator % PHASES];
      let sum = 0;
      for (let i = 0; i < taps.length; i++) {
        const index = center + i - RADIUS;
        if (index >= 0) sum += this.ring[index % this.ring.length] * taps[i];
      }
      values[length++] = sum;
      this.output++;
    }
    return values.slice(0, length);
  }
}
