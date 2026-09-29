// @ts-nocheck
export type Triad = 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4' | 'power';
export interface PitchedChord {
  kind: 'chord';
  root: number;
  triad: Triad;
  fifth: -1 | 0 | 1;
  seventh: 'minor' | 'major' | 'diminished' | null;
  extensions: number[];
  alterations: { degree: number; accidental: number }[];
  addedTones: number[];
  omittedTones: number[];
  bass: number | null;
  spelling: 'sharp' | 'flat';
}
export type Chord = PitchedChord | { kind: 'none' } | { kind: 'unknown' };
export type AnalysisProfile = 'fast' | 'balanced' | 'accurate';
export interface ChordAlternative {
  chord: Chord;
  score: number;
}
export interface ChordSegment {
  id: string;
  start: number;
  end: number;
  chord: Chord;
  score: number;
  alternatives: ChordAlternative[];
}
/** The bars a whole-song analysis was decoded against (native v4 and later). */
export interface BeatGrid {
  /** Bar starts, each one of `beats`. */
  downbeats: number[];
  /** False when the song's local tempo wanders more than 5% from `tempo` (rubato, a speed-up). */
  steady: boolean;
  /** The tracker that heard the beats: `beat-this-final0`, or `librosa` when it was missing. */
  source: string;
}
export interface Analysis {
  id: string;
  fingerprint: string;
  profile: AnalysisProfile;
  modelVersion: string;
  pipelineVersion: string;
  duration: number;
  segments: ChordSegment[];
  beats: number[];
  tempo: number | null;
  meter: number | null;
  key: { root: number; mode: 'major' | 'minor'; score: number } | null;
  waveform: number[];
  boundaries: { time: number; probability: number }[];
  createdAt: string;
  calibration: 'uncalibrated' | 'temperature';
  warnings: string[];
  /** Absent from analyses made before the recognizer read bars. */
  grid?: BeatGrid;
  /** How far the recording sits from A440, in cents; absent from older analyses. */
  tuningCents?: number | null;
}
export interface Track {
  id: string;
  name: string;
  fingerprint: string;
  duration: number;
  importedAt: string;
  favorite: boolean;
}
export interface Correction {
  id: string;
  analysisId: string;
  segmentId: string;
  before: ChordSegment;
  after: ChordSegment;
  createdAt: string;
}
export interface SavedTrack {
  track: Track;
  analysis: Analysis;
  corrections: Correction[];
  source?: SourceProvenance;
}
/** Exact prepared input; provider metadata never grants access to analysis audio. */
export interface SourceProvenance {
  provider: 'commons' | 'youtube';
  id: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  pageUrl: string;
  audio: LicensedAudioSource | AcquiredAudioSource;
}
export interface LicensedAudioSource {
  kind?: undefined;
  url: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  size: number;
}
export interface AcquiredAudioSource {
  kind: 'acquired';
  provider: 'yt-dlp' | 'cobalt' | 'saveapi';
  url: string;
  fingerprint: string;
  mime: string;
  container: string;
  size: number;
}
