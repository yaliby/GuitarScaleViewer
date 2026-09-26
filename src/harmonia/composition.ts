import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AudioAnalysisService } from "../../harmonia/packages/application/contracts";
import { SessionController } from "../../harmonia/packages/application/session";
import {
  desktopWholeSongIdentity,
  desktopWholeSongMode,
  requireDesktopNative,
  type DesktopWholeSongMode,
} from "../../harmonia/packages/audio/desktop-native-gate";
import { WholeSongAnalysisService } from "../../harmonia/packages/audio/whole-song-analysis";
import type { AnalysisProfile, SavedTrack } from "../../harmonia/packages/domain/types";
import { createRepository } from "../../harmonia/packages/persistence/repository";
import { DurableAnalysisRepository } from "./durableRepository";
import { LocalFileProvider } from "../../harmonia/packages/providers/local";
import { NativeWholeSongRecognizer } from "../../harmonia/packages/providers/native-recognizer";

let player: LocalFileProvider | null = null;
let sessionPromise: Promise<{
  session: SessionController;
  analyzer: DesktopWholeSongAnalysis;
}> | null = null;

/**
 * Saved songs use the desktop LV-Chordia recognizer.
 * A missing runtime fails instead of substituting the DSP prototype.
 */
class DesktopWholeSongAnalysis implements AudioAnalysisService {
  private impl = new WholeSongAnalysisService();
  private mode: DesktopWholeSongMode = isTauri() ? "missing" : "browser-dsp";
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.boot();
  }

  private async boot() {
    if (!isTauri()) return;
    try {
      this.mode = desktopWholeSongMode(
        true,
        await invoke<boolean>("recognition_available"),
      );
    } catch {
      this.mode = "missing";
    }
    if (this.mode === "native") {
      this.impl = new WholeSongAnalysisService(new NativeWholeSongRecognizer());
    }
  }

  get pipelineVersion() {
    return desktopWholeSongIdentity(this.mode).pipelineVersion;
  }

  modelVersion(_profile: AnalysisProfile) {
    return desktopWholeSongIdentity(this.mode).modelVersion;
  }

  expectDuration(file: File, duration: number | null) {
    this.impl.expectDuration(file, duration);
  }

  async fingerprint(file: File) {
    await this.ready;
    return this.impl.fingerprint(file);
  }

  async analyze(
    file: File,
    fingerprint: string,
    profile: AnalysisProfile,
    signal: AbortSignal,
    progress: (stage: string, value: number) => void,
  ) {
    await this.ready;
    requireDesktopNative(this.mode);
    return this.impl.analyze(file, fingerprint, profile, signal, progress);
  }

  async demo(signal: AbortSignal) {
    await this.ready;
    requireDesktopNative(this.mode);
    return this.impl.demo(signal);
  }
}

function ensurePlayer(): LocalFileProvider {
  if (!player) player = new LocalFileProvider();
  return player;
}

export function pauseHarmoniaPlayback(): void {
  player?.pause();
}

async function getHarmonia() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const analyzer = new DesktopWholeSongAnalysis();
      const session = new SessionController({
        player: ensurePlayer(),
        repository: new DurableAnalysisRepository(createRepository()),
        analyzer,
      });
      await analyzer.ready;
      await session.initialize();
      return { session, analyzer };
    })();
  }
  return sessionPromise;
}

export async function getHarmoniaSession(): Promise<SessionController> {
  return (await getHarmonia()).session;
}

let gate: Promise<void> = Promise.resolve();

/** One recognizer at a time, whether the listener opened a song or a download just finished. */
function occupy<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(task, task);
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Studio captures are already local files. Their duration label is not a
 * checksum, so preparation does not reject a decode that disagrees with it.
 * `stale` lets a listener walk away while a background extraction is still
 * ahead in the queue, without then opening the player they left.
 */
export async function prepareCapturedSong(
  file: File,
  force = false,
  stale: () => boolean = () => false,
): Promise<void> {
  await occupy(async () => {
    if (stale()) return;
    const { session, analyzer } = await getHarmonia();
    if (stale()) return;
    analyzer.expectDuration(file, null);
    await session.importFile(file, { force });
  });
}

/** Same recognizer, without taking over the song that is on screen. */
export function cacheCapturedSong(
  file: File,
  progress: (stage: string, value: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<SavedTrack | null> {
  return occupy(async () => {
    if (signal?.aborted) return null;
    const { session, analyzer } = await getHarmonia();
    if (signal?.aborted) return null;
    analyzer.expectDuration(file, null);
    return session.storeFile(file, progress, signal);
  });
}
