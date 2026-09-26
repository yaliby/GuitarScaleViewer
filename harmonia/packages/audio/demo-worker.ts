// @ts-nocheck
import { parseChord } from '../domain/chord';
import type { Analysis } from '../domain/types';
const scope = self as unknown as {
  onmessage: () => void;
  postMessage: (value: unknown, transfer: Transferable[]) => void;
};
scope.onmessage = () => {
  const rate = 22050,
    duration = 24;
  const labels = ['Cmaj7', 'Am9', 'Dm9', 'G13', 'Cmaj9/E', 'Fmaj7'];
  const midi = [
    [48, 55, 59, 64],
    [45, 52, 55, 59, 60],
    [50, 57, 60, 64, 65],
    [43, 53, 59, 64, 69],
    [40, 48, 55, 59, 62],
    [41, 48, 52, 57, 60],
  ];
  const samples = new Float32Array(rate * duration);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate,
      index = Math.floor(t / 4),
      local = t % 4;
    const envelope = Math.min(1, local / 0.035) * Math.min(1, (4 - local) / 0.12);
    const pulse = 0.7 + 0.3 * Math.exp(-((local % 0.5) * 6));
    samples[i] =
      midi[index].reduce((sum, note) => {
        const frequency = 440 * 2 ** ((note - 69) / 12);
        return (
          sum +
          Math.sin(2 * Math.PI * frequency * t) +
          0.18 * Math.sin(4 * Math.PI * frequency * t) * Math.exp(-local)
        );
      }, 0) *
      0.045 *
      envelope *
      pulse;
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(bytes);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
  const waveform = Array.from({ length: 900 }, (_, i) => {
    let peak = 0;
    for (let j = Math.floor((i * samples.length) / 900); j < ((i + 1) * samples.length) / 900; j++)
      peak = Math.max(peak, Math.abs(samples[j] ?? 0));
    return peak;
  });
  const analysis: Analysis = {
    id: 'demo-reference-v1',
    fingerprint: 'demo-after-hours-v1',
    profile: 'fast',
    modelVersion: 'demo-reference-v1',
    pipelineVersion: 'reference-v1',
    duration,
    segments: labels.map((label, i) => ({
      id: `demo-${i}`,
      start: i * 4,
      end: (i + 1) * 4,
      chord: parseChord(label),
      score: 1,
      alternatives: [],
    })),
    beats: Array.from({ length: 48 }, (_, i) => i * 0.5),
    tempo: 120,
    meter: 4,
    key: { root: 0, mode: 'major', score: 1 },
    waveform,
    boundaries: labels.slice(1).map((_, i) => ({ time: (i + 1) * 4, probability: 1 })),
    createdAt: new Date().toISOString(),
    calibration: 'uncalibrated',
    warnings: [
      'Synthetic demonstration with authored reference chords. Not a recognition benchmark.',
    ],
  };
  scope.postMessage({ analysis, bytes }, [bytes]);
};
