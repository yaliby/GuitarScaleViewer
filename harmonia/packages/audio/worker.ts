// @ts-nocheck
import { analyzeAudio } from './pipeline';
import type { AnalysisProfile } from '../domain/types';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (value: unknown) => void;
};
scope.onmessage = (
  event: MessageEvent<{
    samples: Float32Array;
    sampleRate: number;
    fingerprint: string;
    profile: AnalysisProfile;
  }>,
) => {
  try {
    const { samples, sampleRate, fingerprint, profile } = event.data;
    const analysis = analyzeAudio(samples, sampleRate, fingerprint, profile, (stage, value) =>
      scope.postMessage({ kind: 'progress', stage, value }),
    );
    scope.postMessage({ kind: 'result', analysis });
  } catch (error) {
    scope.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : 'Audio analysis failed',
    });
  }
};
