// @ts-nocheck
/** Experimental ONNX path is not bundled into Fretboard Studio. Whole-song DSP/native is used instead. */
export const EXPERIMENTAL_MODEL_VERSION = 'unavailable';

export async function analyzeWithModel(): Promise<never> {
  throw new Error(
    'The experimental ONNX analyzer is not bundled here. Use whole-song analysis.',
  );
}
