// @ts-nocheck
/** Wall-clock diagnostics only; never part of the persisted recognition identity. */
export interface WholePipelineTimings {
  inferenceMs: number;
  temporalDecodingMs: number;
  timelineMs: number;
  rhythmKeyMs: number;
  boundaryMs: number;
  pipelineMs: number;
}
export interface WholeWorkerTimings extends WholePipelineTimings {
  normalizeMs: number;
  featuresMs: number;
  workerMs: number;
}
export interface WholeSongTimings extends WholeWorkerTimings {
  decodeMs: number;
  analysisMs: number;
}
