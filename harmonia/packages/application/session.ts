// @ts-nocheck
import type {
  Analysis,
  AnalysisProfile,
  Chord,
  SavedTrack,
  SourceProvenance,
} from '../domain/types';
import {
  correctBoundary,
  correctChord,
  correctSegment,
  validateAnalysis,
  type SegmentCorrection,
} from '../domain/timeline';
import { equalChords } from '../domain/chord';
import type { AnalysisRepository, AudioAnalysisService, LocalPlayback } from './contracts';
import { LatestTask } from './tasks';
import { validateSourceProvenance } from '../domain/source';

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function fixedRecord(record: SavedTrack): SavedTrack {
  validateAnalysis(record.analysis);
  const result = structuredClone(record);
  if (result.source) result.source = validateSourceProvenance(result.source);
  return freezeDeep(result);
}
function sameSource(a: SourceProvenance | undefined, b: SourceProvenance) {
  return a?.provider === b.provider && a.id === b.id && a.audio.url === b.audio.url;
}
async function cacheId(analysis: Analysis, source?: SourceProvenance) {
  const identity = JSON.stringify([
    analysis.fingerprint,
    analysis.profile,
    analysis.modelVersion,
    analysis.pipelineVersion,
    source?.provider ?? null,
    source?.id ?? null,
    source?.audio.url ?? null,
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `prepared:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface SessionState {
  status: 'idle' | 'preparing' | 'analyzing' | 'ready' | 'cancelled' | 'failed';
  stage: string;
  progress: number;
  current: SavedTrack | null;
  library: SavedTrack[];
  error: string | null;
  failureKind?: 'input';
  profile: AnalysisProfile;
  saveState: 'saved' | 'saving' | 'unsaved';
}
export interface SessionDependencies {
  player: LocalPlayback;
  repository: AnalysisRepository;
  analyzer: AudioAnalysisService;
}
export class SessionController {
  readonly player: LocalPlayback;
  private tasks = new LatestTask();
  private abort: AbortController | null = null;
  private listeners = new Set<() => void>();
  private persisted = new Map<string, SavedTrack>();
  private saveQueue: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private playbackRevision = 0;
  private unsubscribePlayback: () => void;
  private state: SessionState = {
    status: 'idle',
    stage: '',
    progress: 0,
    current: null,
    library: [],
    error: null,
    profile: 'balanced',
    saveState: 'saved',
  };
  constructor(private dependencies: SessionDependencies) {
    this.player = dependencies.player;
    this.unsubscribePlayback = this.player.onError((error) => {
      if (!this.state.current || !this.player.available) return;
      this.player.pause();
      this.update({ error: this.message(error) });
    });
  }
  dispose() {
    ++this.playbackRevision;
    this.unsubscribePlayback();
    this.cancel();
    this.player.release();
    this.listeners.clear();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    if (!this.initialization)
      this.initialization = this.dependencies.repository
        .list()
        .then(({ records, issues }) => {
          records = records.map(fixedRecord);
          records.forEach((record) => this.persisted.set(record.analysis.id, record));
          const present = new Set(this.state.library.map((r) => r.analysis.id));
          this.update({
            library: [...this.state.library, ...records.filter((r) => !present.has(r.analysis.id))],
            ...(issues.length
              ? {
                  error: `${issues.length} damaged saved analyses were isolated. Healthy sessions remain available; damaged records were retained.`,
                }
              : {}),
          });
        })
        .catch((error) => {
          this.update({ error: this.message(error) });
        });
    return this.initialization;
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : 'An unexpected error occurred';
  }
  clearError() {
    this.update({ error: null });
  }
  setProfile(profile: AnalysisProfile) {
    this.update({ profile });
  }
  private fail(error: unknown) {
    this.update({ error: this.message(error), status: this.state.current ? 'ready' : 'failed' });
  }
  cancel() {
    this.tasks.cancel();
    this.abort?.abort();
    this.abort = null;
    this.update({
      status: this.state.current ? 'ready' : 'cancelled',
      stage: 'Cancelled',
      progress: 0,
    });
  }
  private start() {
    ++this.playbackRevision;
    this.cancel();
    this.player.release();
    this.abort = new AbortController();
    this.update({
      current: null,
      error: null,
      status: 'preparing',
      failureKind: undefined,
      progress: 0,
      stage: 'Preparing local audio',
      saveState: 'saved',
    });
    return { token: this.tasks.begin(), signal: this.abort.signal };
  }
  private async accept(
    analysis: Analysis,
    file: Blob,
    name: string,
    token: number,
    prepared?: SavedTrack,
    source?: SourceProvenance,
  ) {
    if (!this.tasks.current(token)) return;
    validateAnalysis(analysis);
    const existing = this.state.library.find((r) => r.analysis.id === analysis.id);
    const prior = this.state.library.find((r) => r.track.fingerprint === analysis.fingerprint);
    const record = fixedRecord(
      prepared ??
        existing ?? {
          track: {
            id: analysis.fingerprint,
            name,
            duration: analysis.duration,
            fingerprint: analysis.fingerprint,
            importedAt: prior?.track.importedAt ?? new Date().toISOString(),
            favorite: prior?.track.favorite ?? false,
          },
          analysis,
          corrections: [],
          ...(source ? { source } : {}),
        },
    );
    this.player.load(file);
    this.update({ current: record, status: 'ready', progress: 1 });
    await this.save(record);
  }
  private save(record: SavedTrack): Promise<void> {
    this.update({
      library: [record, ...this.state.library.filter((r) => r.analysis.id !== record.analysis.id)],
      ...(this.state.current === record ? { saveState: 'saving' as const } : {}),
    });
    const operation = this.saveQueue
      .then(() => this.dependencies.repository.save(record))
      .then(() => {
        this.persisted.set(record.analysis.id, record);
        if (this.state.current === record) this.update({ saveState: 'saved' });
      })
      .catch((error) => {
        if (this.state.current === record)
          this.update({
            saveState: 'unsaved',
            error: `Changes are not saved: ${this.message(error)}`,
          });
        throw error;
      });
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }
  /**
   * Whole-song recognition that stays off the open player. The library gains the
   * analysis; `current` and the visible status stay whatever the listener is doing.
   */
  async storeFile(
    file: File,
    progress: (stage: string, value: number) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<SavedTrack | null> {
    if (signal?.aborted) return null;
    const profile = this.state.profile;
    try {
      await this.initialize();
      if (signal?.aborted) return null;
      progress('Preparing local audio', 0);
      const fingerprint = await this.dependencies.analyzer.fingerprint(file);
      if (signal?.aborted) return null;
      const compatible = (record: SavedTrack) =>
        record.track.fingerprint === fingerprint &&
        record.analysis.profile === profile &&
        record.analysis.pipelineVersion === this.dependencies.analyzer.pipelineVersion &&
        record.analysis.modelVersion === this.dependencies.analyzer.modelVersion(profile);
      const cached = this.state.library
        .filter(compatible)
        .sort((a, b) => Date.parse(b.analysis.createdAt) - Date.parse(a.analysis.createdAt))[0];
      if (cached) {
        progress('Loaded cached analysis', 1);
        return cached;
      }
      const analysis = await this.dependencies.analyzer.analyze(
        file,
        fingerprint,
        profile,
        signal ?? new AbortController().signal,
        progress,
      );
      if (signal?.aborted) return null;
      if (
        analysis.fingerprint !== fingerprint ||
        analysis.profile !== profile ||
        analysis.pipelineVersion !== this.dependencies.analyzer.pipelineVersion ||
        analysis.modelVersion !== this.dependencies.analyzer.modelVersion(profile)
      )
        throw new Error(
          'Prepared analysis identity does not match its source and requested pipeline',
        );
      const record = fixedRecord({
        track: {
          id: analysis.fingerprint,
          name: file.name,
          duration: analysis.duration,
          fingerprint: analysis.fingerprint,
          importedAt: new Date().toISOString(),
          favorite: false,
        },
        analysis,
        corrections: [],
      });
      await this.save(record);
      return record;
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    }
  }
  async importFile(file: File, options: { source?: SourceProvenance; force?: boolean } = {}) {
    const previous = this.state.current;
    const { token, signal } = this.start();
    const profile = this.state.profile;
    try {
      const source = options.source ? validateSourceProvenance(options.source) : undefined;
      await this.initialize();
      if (!this.tasks.current(token)) return;
      const fingerprint = await this.dependencies.analyzer.fingerprint(file);
      if (source?.audio.kind === 'acquired' && source.audio.fingerprint !== fingerprint)
        throw Object.assign(new Error('Acquired audio checksum mismatch'), {
          code: 'INVALID_AUDIO_INPUT',
        });
      if (!this.tasks.current(token)) return;
      const compatible = (r: SavedTrack) =>
        r.track.fingerprint === fingerprint &&
        r.analysis.profile === profile &&
        r.analysis.pipelineVersion === this.dependencies.analyzer.pipelineVersion &&
        r.analysis.modelVersion === this.dependencies.analyzer.modelVersion(profile);
      const candidates = this.state.library
        .filter(compatible)
        .sort((a, b) => Date.parse(b.analysis.createdAt) - Date.parse(a.analysis.createdAt));
      const cached = options.force
        ? undefined
        : source
          ? previous && compatible(previous) && sameSource(previous.source, source)
            ? previous
            : (candidates.find((r) => sameSource(r.source, source)) ??
              (previous && compatible(previous) && !previous.source
                ? previous
                : (candidates.find((r) => !r.source && r.corrections.length > 0) ??
                  candidates.find((r) => !r.source))))
          : previous && compatible(previous)
            ? previous
            : candidates[0];
      if (cached) {
        let prepared = cached;
        if (source && !cached.source) {
          const id = await cacheId(cached.analysis, source);
          prepared = {
            ...cached,
            source,
            analysis: { ...cached.analysis, id },
            corrections: cached.corrections.map((correction) => ({
              ...correction,
              analysisId: id,
            })),
          };
        }
        await this.accept(prepared.analysis, file, file.name, token, prepared);
        if (this.tasks.current(token)) this.update({ stage: 'Loaded cached analysis' });
        return;
      }
      this.update({ status: 'analyzing' });
      const analysis = await this.dependencies.analyzer.analyze(
        file,
        fingerprint,
        profile,
        signal,
        (stage, progress) => {
          if (this.tasks.current(token)) this.update({ stage, progress });
        },
      );
      if (
        analysis.fingerprint !== fingerprint ||
        analysis.profile !== profile ||
        analysis.pipelineVersion !== this.dependencies.analyzer.pipelineVersion ||
        analysis.modelVersion !== this.dependencies.analyzer.modelVersion(profile)
      )
        throw new Error(
          'Prepared analysis identity does not match its source and requested pipeline',
        );
      const id = source || options.force ? await cacheId(analysis, source) : analysis.id;
      // Reanalysis ordering survives repositories that sort by track import time.
      const createdAt = options.force
        ? new Date(
            Math.max(Date.now(), ...candidates.map((r) => Date.parse(r.analysis.createdAt) + 1)),
          ).toISOString()
        : analysis.createdAt;
      await this.accept(
        {
          ...analysis,
          createdAt,
          id: options.force ? `${id}:revision:${crypto.randomUUID()}` : id,
        },
        file,
        file.name,
        token,
        undefined,
        source,
      );
    } catch (error) {
      if (this.tasks.current(token) && !signal.aborted) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'INVALID_AUDIO_INPUT'
        )
          this.update({ failureKind: 'input' });
        if (this.state.current) this.update({ error: this.message(error) });
        else this.fail(error);
      }
    }
  }
  async demo() {
    const { token, signal } = this.start();
    try {
      await this.initialize();
      if (!this.tasks.current(token)) return;
      const result = await this.dependencies.analyzer.demo(signal);
      await this.accept(result.analysis, result.file, 'After hours · studio study', token);
    } catch (error) {
      if (this.tasks.current(token) && !signal.aborted) this.fail(error);
    }
  }
  open(record: SavedTrack) {
    const snapshot = fixedRecord(record);
    ++this.playbackRevision;
    this.cancel();
    this.player.release();
    this.update({
      current: snapshot,
      status: 'ready',
      profile: record.analysis.profile,
      error: null,
      saveState: this.persisted.get(record.analysis.id) === record ? 'saved' : 'unsaved',
    });
  }
  async togglePlayback() {
    const revision = this.playbackRevision;
    try {
      if (this.player.playing) this.player.pause();
      else await this.player.play();
      if (revision === this.playbackRevision) this.update({});
    } catch (error) {
      if (revision === this.playbackRevision) this.update({ error: this.message(error) });
    }
  }
  private async correction(analysis: Analysis) {
    const current = this.state.current;
    if (!current) return;
    const createdAt = new Date().toISOString();
    const changes = analysis.segments.flatMap((after, index) => {
      const before = current.analysis.segments[index];
      const sameSpelling =
        before.chord.kind !== 'chord' ||
        after.chord.kind !== 'chord' ||
        before.chord.spelling === after.chord.spelling;
      if (
        before.start === after.start &&
        before.end === after.end &&
        sameSpelling &&
        equalChords(before.chord, after.chord)
      )
        return [];
      return [
        {
          id: crypto.randomUUID(),
          analysisId: analysis.id,
          segmentId: after.id,
          before,
          after,
          createdAt,
        },
      ];
    });
    const record = fixedRecord({
      ...current,
      analysis,
      corrections: [...current.corrections, ...changes],
    });
    this.update({
      current: record,
      ...(this.state.error?.startsWith('Changes are not saved:') ? { error: null } : {}),
    });
    await this.save(record);
  }
  async editChord(segmentId: string, chord: Chord) {
    if (this.state.current)
      await this.correction(correctChord(this.state.current.analysis, segmentId, chord));
  }
  async editSegment(segmentId: string, correction: SegmentCorrection) {
    if (this.state.current)
      await this.correction(correctSegment(this.state.current.analysis, segmentId, correction));
  }
  async editBoundary(segmentId: string, time: number) {
    if (this.state.current)
      await this.correction(correctBoundary(this.state.current.analysis, segmentId, time));
  }
  async favorite() {
    const current = this.state.current;
    if (!current) return;
    const revision = this.playbackRevision;
    const favorite = !current.track.favorite;
    const relatedIds = this.state.library
      .filter((r) => r.track.fingerprint === current.track.fingerprint)
      .map((r) => r.analysis.id);
    try {
      for (const id of relatedIds) {
        const latest = this.state.library.find((r) => r.analysis.id === id);
        if (!latest) continue;
        const record = fixedRecord({
          ...latest,
          track: { ...latest.track, favorite },
        });
        if (this.state.current?.analysis.id === id) this.update({ current: record });
        await this.save(record);
      }
    } catch (error) {
      if (revision === this.playbackRevision) this.update({ error: this.message(error) });
    }
  }
}
