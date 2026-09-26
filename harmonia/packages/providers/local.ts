// @ts-nocheck
import type { LocalPlayback } from '../application/contracts';
export class LocalFileProvider implements LocalPlayback {
  readonly id = 'local';
  readonly capabilities = {
    play: true,
    pause: true,
    seek: true,
    position: true,
    duration: true,
    rawAnalysisAvailable: true,
    offlineAvailable: true,
  };
  private media = new Audio();
  private sourceGeneration = 0;
  private errorListeners = new Set<(error: Error) => void>();
  get audio() {
    return this.media;
  }
  private objectUrl: string | null = null;
  private preview = 0;
  private speed = 1;
  private preferredVolume = 1;
  get volume() {
    return this.preferredVolume;
  }
  private loop: { start: number; end: number } | null = null;
  constructor() {
    this.audio.preload = 'metadata';
  }
  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }
  load(file: Blob) {
    this.release();
    const audio = new Audio(),
      generation = this.sourceGeneration;
    this.media = audio;
    audio.preload = 'metadata';
    audio.defaultPlaybackRate = this.speed;
    audio.playbackRate = this.speed;
    audio.volume = this.volume;
    const current = () =>
      generation === this.sourceGeneration && audio === this.media && this.available;
    const report = (error: Error) => {
      if (current()) for (const listener of this.errorListeners) listener(error);
    };
    audio.addEventListener('timeupdate', () => {
      if (current() && this.loop && audio.currentTime >= this.loop.end)
        audio.currentTime = this.loop.start;
    });
    audio.addEventListener('ended', () => {
      if (current() && this.loop) {
        audio.currentTime = this.loop.start;
        void audio
          .play()
          .catch((error) =>
            report(
              error instanceof Error
                ? error
                : new Error('Loop playback failed. Try playing the file again.'),
            ),
          );
      }
    });
    audio.addEventListener('error', () => {
      const messages: Record<number, string> = {
        1: 'Audio playback was interrupted. Reopen the local audio file.',
        2: 'The local audio could not be read during playback. Reopen the file.',
        3: 'This audio could not be decoded for playback. Try an unprotected WAV, MP3 or FLAC file.',
        4: 'This audio format is not supported for playback. Try an unprotected WAV, MP3 or FLAC file.',
      };
      report(
        new Error(
          messages[audio.error?.code ?? 0] ?? 'Audio playback failed. Reopen the local audio file.',
        ),
      );
    });
    this.objectUrl = URL.createObjectURL(file);
    audio.src = this.objectUrl;
    audio.load();
  }
  release() {
    ++this.sourceGeneration;
    const url = this.objectUrl;
    this.objectUrl = null;
    this.preview = 0;
    this.loop = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (url) URL.revokeObjectURL(url);
  }
  get available() {
    return this.objectUrl !== null;
  }
  get position() {
    return this.available ? this.audio.currentTime : this.preview;
  }
  get duration() {
    return this.available && Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }
  get playing() {
    return this.available && !this.audio.paused;
  }
  play() {
    if (!this.available)
      return Promise.reject(new Error('Reopen the local audio file to play this saved analysis.'));
    return this.audio.play();
  }
  pause() {
    this.audio.pause();
  }
  seek(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    this.preview = Math.max(0, seconds);
    if (this.available)
      this.audio.currentTime = this.duration ? Math.min(this.duration, this.preview) : this.preview;
  }
  setSpeed(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 1.5)
      throw new Error('Playback speed must be between 0.5 and 1.5');
    this.audio.playbackRate = rate;
    this.speed = rate;
  }
  setVolume(volume: number) {
    if (!Number.isFinite(volume)) throw new Error('Playback volume must be a finite number.');
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.preferredVolume = this.audio.volume;
  }
  setLoop(range: { start: number; end: number } | null) {
    if (
      range &&
      (!Number.isFinite(range.start) ||
        !Number.isFinite(range.end) ||
        range.start < 0 ||
        range.end <= range.start)
    )
      throw new Error('Loop bounds must be finite, nonnegative and end after the start.');
    this.loop = range ? { ...range } : null;
  }
}
