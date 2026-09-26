// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import type { Analysis } from '../domain/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function run(input: unknown) {
  const messages: { kind: string; analysis?: Analysis; message?: string; value?: number }[] = [];
  const scope = {
    onmessage: async (_event: MessageEvent) => {},
    postMessage: (value: (typeof messages)[number]) => messages.push(value),
  };
  vi.stubGlobal('self', scope);
  await import('./whole-song-worker');
  await scope.onmessage({ data: input } as MessageEvent);
  return messages;
}

it('analyzes the never-played end of a full stereo recording through the real worker entrypoint', async () => {
  const rate = 22050;
  const channel = Float32Array.from({ length: rate * 4 }, (_, i) => {
    if (i < rate * 2) return 0;
    return [130.8128, 164.8138, 195.9977].reduce(
      (sum, f) => sum + 0.1 * Math.sin((2 * Math.PI * f * i) / rate),
      0,
    );
  });
  const messages = await run({
    channels: [channel, channel.slice()],
    sampleRate: rate,
    fingerprint: 'a'.repeat(64),
    profile: 'balanced',
  });
  const result = messages.at(-1)!;
  expect(result.kind).toBe('result');
  expect(result.analysis!.segments[0].chord.kind).toBe('none');
  expect(result.analysis!.segments.at(-1)).toMatchObject({
    end: 4,
    chord: { kind: 'chord', root: 0 },
  });
  expect(messages.some((message) => message.kind === 'progress' && message.value === 1)).toBe(true);
});

it.each([
  { channels: [] },
  { channels: [new Float32Array(1), new Float32Array(2)] },
  { channels: [new Float32Array([NaN])] },
  { channels: [new Float32Array(1)], sampleRate: 1 },
  { channels: [new Float32Array(1)], profile: 'unsupported' },
])('rejects malformed PCM inputs without emitting a partial analysis: %s', async (invalid) => {
  const messages = await run({
    sampleRate: 22050,
    fingerprint: 'a'.repeat(64),
    profile: 'balanced',
    ...invalid,
  });
  expect(messages.at(-1)?.kind).toBe('error');
  expect(messages.some((message) => message.kind === 'result')).toBe(false);
});
