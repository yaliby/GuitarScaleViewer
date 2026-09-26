// @ts-nocheck
import { invoke } from '@tauri-apps/api/core';
import type { WholeSongRecognizer } from '../application/whole-song-recognizer';

export class NativeWholeSongRecognizer implements WholeSongRecognizer {
  async recognize(samples: Float32Array, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!samples.length || samples.length > 22050 * 1200)
      throw new Error('Invalid recognition input');
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void invoke('recognition_cancel', { requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await invoke(
        'recognition_run',
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        { headers: { 'x-harmonia-request-id': requestId } },
      );
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
