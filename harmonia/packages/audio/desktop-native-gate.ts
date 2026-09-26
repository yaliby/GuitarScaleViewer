import { NATIVE_MODEL_VERSION, NATIVE_PIPELINE_VERSION } from './native-whole';
import { WHOLE_SONG_MODEL_VERSION, WHOLE_SONG_PIPELINE_VERSION } from './whole-pipeline';

export const NATIVE_RECOGNITION_UNAVAILABLE =
  'Whole-song recognition is unavailable. Check the local recognition runtime.';

export type DesktopWholeSongMode = 'browser-dsp' | 'native' | 'missing';

/** Desktop Search & Analyze always uses LV-Chordia identity; it never caches DSP as native. */
export function desktopWholeSongMode(
  isDesktop: boolean,
  recognitionAvailable: boolean,
): DesktopWholeSongMode {
  if (!isDesktop) return 'browser-dsp';
  return recognitionAvailable ? 'native' : 'missing';
}

export function desktopWholeSongIdentity(mode: DesktopWholeSongMode): {
  pipelineVersion: string;
  modelVersion: string;
} {
  if (mode === 'browser-dsp') {
    return { pipelineVersion: WHOLE_SONG_PIPELINE_VERSION, modelVersion: WHOLE_SONG_MODEL_VERSION };
  }
  return { pipelineVersion: NATIVE_PIPELINE_VERSION, modelVersion: NATIVE_MODEL_VERSION };
}

export function requireDesktopNative(mode: DesktopWholeSongMode): void {
  if (mode === 'missing') throw new Error(NATIVE_RECOGNITION_UNAVAILABLE);
}
