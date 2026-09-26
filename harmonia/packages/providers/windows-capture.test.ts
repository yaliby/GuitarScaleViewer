// @ts-nocheck
import { expect, it, vi } from 'vitest';
import { WindowsCaptureService } from './windows-capture';

const session = { captureId: 'capture-1', sampleRate: 48000, channels: 2, blockFrames: 960 };
const block = {
  ...session,
  sequence: 0,
  firstFrame: 0,
  frameCount: 960,
  devicePosition: 0,
  qpc100ns: '100',
  timestampValid: true,
  silent: false,
  discontinuity: false,
  droppedFramesBefore: 0,
  samples: Array(1920).fill(0.25),
};
it('converts bounded native PCM into transferable float32 without altering metadata', async () => {
  const invoke = vi.fn(async () => ({
    captureId: 'capture-1',
    status: 'capturing',
    blocks: [block],
  }));
  const provider = new WindowsCaptureService(invoke, () => true);
  const result = await provider.read('capture-1');
  expect(invoke).toHaveBeenCalledWith('capture_read', { captureId: 'capture-1' });
  expect(result.blocks[0].samples).toBeInstanceOf(Float32Array);
  expect(result.blocks[0].samples[1]).toBe(0.25);
  expect(result.blocks[0].qpc100ns).toBe('100');
});
it.each([
  { ...block, samples: [NaN] },
  { ...block, samples: Array(1920).fill(1e308) },
  { ...block, firstFrame: -1 },
  { ...block, captureId: 'other' },
  { ...block, frameCount: 961 },
  { ...block, timestampValid: 'yes' },
])('rejects malformed native PCM before streaming analysis', async (bad) => {
  const provider = new WindowsCaptureService(
    async () => ({ captureId: 'capture-1', status: 'capturing', blocks: [bad] }),
    () => true,
  );
  await expect(provider.read('capture-1')).rejects.toThrow();
});
it('rejects unbounded batches and session formats', async () => {
  const provider = new WindowsCaptureService(
    async (command) =>
      command === 'capture_start'
        ? { ...session, channels: 64 }
        : { captureId: 'capture-1', status: 'capturing', blocks: Array(5).fill(block) },
    () => true,
  );
  await expect(provider.read('capture-1')).rejects.toThrow();
  await expect(provider.start('app')).rejects.toThrow();
});
it('reports unsupported browser preview without requesting capture or inventing sources', async () => {
  const invoke = vi.fn();
  const provider = new WindowsCaptureService(invoke, () => false);
  await expect(provider.sources()).rejects.toThrow('Windows desktop');
  await expect(provider.start('app')).rejects.toThrow('Windows desktop');
  expect(invoke).not.toHaveBeenCalled();
});
