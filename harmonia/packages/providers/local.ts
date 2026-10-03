// @ts-nocheck
import type { LocalPlayback } from '../application/contracts';
import { blobToDataUrl, mediaNeedsDataUrl } from './mediaUrl';
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
  // The singer slider: with stems loaded and the singer below full, the main element plays the
  // band alone and `voice` plays the singer in step with it at the chosen level.
  private stems: { instrumental: string; vocals: string } | null = null;
  private singerLevel = 1;
  private voice: HTMLAudioElement | null = null;
  private voiceStop: (() => void) | null = null;
  private swap: { at: number; resume: boolean } | null = null;
  private swapTries = 0;
  private lastDuration = 0;
  private playingSrc: string | null = null;
  // What the original plays from: the saved file's blob: URL, or on WebKit a data: URL that takes a
  // moment to make (see mediaUrl.ts). Null until it is there; `ready` settles when it is.
  private sourceUrl: string | null = null;
  private ready: Promise<void> = Promise.resolve();
  get singer() {
    return this.singerLevel;
  }
  get hasStems() {
    return this.stems !== null;
  }
  setStems(urls: { instrumental: string; vocals: string } | null) {
    this.stems = urls;
    this.dropVoice(); // a different pair of files, or none: the old singer must not play on
    this.applySinger();
  }
  setSinger(level: number) {
    if (!Number.isFinite(level)) throw new Error('Singer level must be a finite number.');
    this.singerLevel = Math.max(0, Math.min(1, level));
    this.applySinger();
  }
  private applySinger() {
    if (!this.available) return;
    if (!this.sourceUrl) return; // the original is still being made ready; load() applies the singer after
    const audio = this.media;
    const on = this.stems !== null && this.singerLevel < 0.99;
    const wanted = on ? this.stems.instrumental : this.sourceUrl;
    if (wanted && this.playingSrc !== wanted) this.switchSource(audio, wanted);
    if (!on) return this.dropVoice();
    // The singer is loaded after the band's swap has landed, not beside it: WebKit refused one of two
    // media files loaded at once.
    if (!this.voice && !this.swap) this.startVoice(audio);
    if (this.voice) this.voice.volume = this.preferredVolume * this.singerLevel;
  }
  // Swapping the file under the element restarts it: `load()` pauses, zeroes `currentTime` and
  // puts `playbackRate` back to its default. So the place, the play state and the speed are
  // carried across by hand, and a swap landing on an unfinished one keeps what the first took.
  private switchSource(audio: HTMLAudioElement, src: string) {
    if (!this.swap) this.swapTries = 0;
    const pending = (this.swap ??= { at: audio.currentTime, resume: !audio.paused });
    const generation = this.sourceGeneration;
    this.playingSrc = src;
    audio.src = src;
    audio.defaultPlaybackRate = this.speed;
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (
          generation !== this.sourceGeneration ||
          audio !== this.media ||
          this.swap !== pending ||
          this.playingSrc !== src
        )
          return;
        this.swap = null;
        this.applySinger();
        audio.playbackRate = this.speed;
        // A song that has not been played is left at its start: no seek to go wrong.
        if (pending.at >= 0.05 || audio.currentTime !== 0) audio.currentTime = pending.at;
        if (pending.resume) void audio.play().catch(() => undefined);
      },
      { once: true },
    );
    audio.load();
  }
  // The singer is a second element that has to keep the main one's clock. It starts only once it
  // has data (else it would trail by however long it took to load), and afterwards small drift
  // is absorbed by a slight speed change: seeking a playing element is itself audible and costs
  // a rebuffer, so only a real miss is jumped.
  private startVoice(audio: HTMLAudioElement) {
    const voice = new Audio();
    const stop = new AbortController();
    const { signal } = stop;
    const live = () => this.voice === voice && this.media === audio;
    const align = () => {
      voice.currentTime = audio.currentTime;
    };
    const rate = () => {
      voice.defaultPlaybackRate = audio.playbackRate;
      voice.playbackRate = audio.playbackRate;
    };
    const run = () => {
      if (!live() || audio.paused || voice.readyState < 2 || !voice.paused) return;
      align();
      void voice.play().catch(() => undefined);
    };
    const tick = () => {
      run(); // a start that lost the race with its own seek is retried here
      if (!live() || audio.paused || voice.paused || voice.seeking || voice.readyState < 2) return;
      const drift = voice.currentTime - audio.currentTime;
      if (Math.abs(drift) > 0.25) {
        align();
        voice.playbackRate = audio.playbackRate;
      } else if (Math.abs(drift) > 0.015) {
        voice.playbackRate = audio.playbackRate * (1 - Math.max(-0.08, Math.min(0.08, drift)));
      } else voice.playbackRate = audio.playbackRate;
    };
    this.voice = voice;
    this.voiceStop = () => stop.abort();
    voice.preload = 'auto';
    voice.src = this.stems.vocals;
    for (const name of ['canplay', 'loadeddata', 'seeked']) voice.addEventListener(name, run, { signal });
    let tries = 0;
    voice.addEventListener(
      'error',
      () => {
        if (tries++ >= 3) return;
        setTimeout(() => {
          if (!live()) return;
          voice.src = this.stems.vocals;
          voice.load();
        }, 300);
      },
      { signal },
    );
    audio.addEventListener('play', run, { signal });
    audio.addEventListener('playing', run, { signal });
    audio.addEventListener('seeking', () => live() && align(), { signal });
    audio.addEventListener('seeked', () => live() && align(), { signal });
    audio.addEventListener('ratechange', () => live() && rate(), { signal });
    for (const name of ['pause', 'waiting', 'ended'])
      audio.addEventListener(name, () => live() && voice.pause(), { signal });
    const timer = setInterval(tick, 100);
    signal.addEventListener('abort', () => clearInterval(timer));
    run();
  }
  private dropVoice() {
    const voice = this.voice;
    this.voice = null;
    this.voiceStop?.();
    this.voiceStop = null;
    if (!voice) return;
    voice.pause();
    voice.removeAttribute('src');
    voice.load();
  }
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
      // WebKit sometimes refuses a file that is fine a moment later: a swap gets a few more tries.
      if (audio === this.media && this.swap && this.swapTries < 3) {
        this.swapTries++;
        const src = this.playingSrc;
        setTimeout(() => {
          if (audio !== this.media || !this.swap || this.playingSrc !== src) return;
          audio.src = src;
          audio.load();
        }, 250);
        return;
      }
      if (audio === this.media) this.swap = null; // a file that will not load must not freeze the clock
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
    if (!mediaNeedsDataUrl()) {
      this.sourceUrl = this.playingSrc = this.objectUrl;
      audio.src = this.objectUrl;
      audio.load();
      return;
    }
    this.sourceUrl = this.playingSrc = null;
    this.ready = blobToDataUrl(file).then(
      (url) => {
        if (generation !== this.sourceGeneration || audio !== this.media) return;
        this.sourceUrl = this.playingSrc = url;
        audio.src = url;
        audio.load();
        this.applySinger(); // stems that arrived while the original was being read
      },
      () => report(new Error('The local audio could not be read. Reopen the file.')),
    );
  }
  release() {
    ++this.sourceGeneration;
    const url = this.objectUrl;
    this.objectUrl = null;
    this.preview = 0;
    this.loop = null;
    this.stems = null;
    this.swap = null;
    this.lastDuration = 0;
    this.playingSrc = null;
    this.sourceUrl = null;
    this.ready = Promise.resolve();
    this.dropVoice();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (url) URL.revokeObjectURL(url);
  }
  get available() {
    return this.objectUrl !== null;
  }
  get position() {
    if (!this.available) return this.preview;
    return this.swap ? this.swap.at : this.audio.currentTime;
  }
  get duration() {
    if (!this.available) return 0;
    if (Number.isFinite(this.audio.duration)) this.lastDuration = this.audio.duration;
    return this.swap || Number.isFinite(this.audio.duration) ? this.lastDuration : 0;
  }
  get playing() {
    return this.available && (this.swap ? this.swap.resume : !this.audio.paused);
  }
  play() {
    if (!this.available)
      return Promise.reject(new Error('Reopen the local audio file to play this saved analysis.'));
    if (!this.sourceUrl) // pressed while the file is being made ready
      return this.ready.then(() =>
        this.sourceUrl ? this.play() : Promise.reject(new Error('The local audio could not be read. Reopen the file.')),
      );
    if (this.swap) {
      this.swap.resume = true;
      return Promise.resolve();
    }
    return this.audio.play();
  }
  pause() {
    if (this.swap) this.swap.resume = false;
    this.audio.pause();
  }
  seek(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    this.preview = Math.max(0, seconds);
    if (this.available) {
      const to = this.duration ? Math.min(this.duration, this.preview) : this.preview;
      if (this.swap) this.swap.at = to;
      this.audio.currentTime = to;
    }
  }
  setSpeed(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 1.5)
      throw new Error('Playback speed must be between 0.5 and 1.5');
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.speed = rate;
  }
  setVolume(volume: number) {
    if (!Number.isFinite(volume)) throw new Error('Playback volume must be a finite number.');
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.preferredVolume = this.audio.volume;
    if (this.voice) this.voice.volume = this.preferredVolume * this.singerLevel;
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
