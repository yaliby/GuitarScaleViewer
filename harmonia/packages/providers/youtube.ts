// @ts-nocheck
import type { MusicProvider } from '../application/contracts';

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}
export interface YouTubePlayerOptions {
  videoId: string;
  width: number;
  height: number;
  playerVars: { origin: string; autoplay: 0; controls: 1; playsinline: 1 };
  events: {
    onReady(): void;
    onStateChange(event: { data: number }): void;
    onError(event: { data: number }): void;
    onAutoplayBlocked(): void;
  };
}
export type YouTubePlayerFactory = (
  host: HTMLElement,
  options: YouTubePlayerOptions,
) => YouTubePlayer;

export type YouTubeErrorCode =
  | 'invalid-source'
  | 'not-ready'
  | 'unavailable'
  | 'embedding-disabled'
  | 'client-identification'
  | 'playback-failed'
  | 'autoplay-blocked'
  | 'timeout'
  | 'cancelled'
  | 'disposed';

export class YouTubeProviderError extends Error {
  constructor(
    readonly code: YouTubeErrorCode,
    message: string,
    readonly sdkCode?: number,
  ) {
    super(message);
    this.name = 'YouTubeProviderError';
  }
}

export type YouTubeStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'buffering'
  | 'paused'
  | 'ended'
  | 'blocked'
  | 'error'
  | 'disposed';

interface PendingOperation {
  promise: Promise<void>;
  finish(error?: YouTubeProviderError): void;
}
interface PlayerSession {
  player: YouTubePlayer | null;
  ready: boolean;
  load: PendingOperation;
  play: PendingOperation | null;
}

/**
 * Official IFrame API adapter only. The caller owns a visible, unobscured host
 * and an already-loaded SDK in an isolated, non-privileged browsing context.
 * Never mount a remote SDK in Harmonia's privileged application page.
 */
export class YouTubeProvider implements MusicProvider {
  readonly id = 'youtube';
  readonly capabilities = Object.freeze({
    play: true,
    pause: true,
    seek: true,
    position: true,
    duration: true,
    rawAnalysisAvailable: false,
    offlineAvailable: false,
  });
  private session: PlayerSession | null = null;
  private state: YouTubeStatus = 'idle';
  private lastError: YouTubeProviderError | null = null;
  private listeners = new Set<(error: YouTubeProviderError) => void>();
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly factory: YouTubePlayerFactory,
    options: { origin: string; timeoutMs?: number },
  ) {
    let origin: URL;
    try {
      origin = new URL(options.origin);
    } catch {
      throw new Error('YouTube requires a valid HTTP(S) origin.');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (
      origin.origin !== options.origin ||
      !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))
    )
      throw new Error('YouTube requires an HTTPS origin or an HTTP loopback development origin.');
    this.origin = origin.origin;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120000)
      throw new Error('YouTube timeout must be finite and between 100 and 120000 milliseconds.');
  }

  get status() {
    return this.state;
  }
  get error() {
    return this.lastError;
  }
  get available() {
    return Boolean(this.session?.ready && this.session.player);
  }
  get playing() {
    return this.available && this.state === 'playing';
  }
  get position() {
    return this.readClock('getCurrentTime');
  }
  get duration() {
    return this.readClock('getDuration');
  }

  onError(listener: (error: YouTubeProviderError) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  load(source: string, host: HTMLElement): Promise<void> {
    if (this.state === 'disposed')
      return Promise.reject(
        new YouTubeProviderError(
          'disposed',
          'This YouTube provider was disposed. Create a new player.',
        ),
      );
    let videoId: string;
    try {
      videoId = parseYouTubeVideoId(source);
    } catch (error) {
      return Promise.reject(error);
    }
    this.close(new YouTubeProviderError('cancelled', 'YouTube source was replaced.'));
    this.lastError = null;
    this.state = 'loading';
    const session: PlayerSession = {
      player: null,
      ready: false,
      play: null,
      load: this.pending(() =>
        this.fail(
          session,
          new YouTubeProviderError(
            'timeout',
            'YouTube did not become ready. Check the connection and reopen the video.',
          ),
        ),
      ),
    };
    this.session = session;
    const current = () => this.session === session;
    let readyReceived = false;
    const markReady = () => {
      if (!current() || session.ready || !session.player || !readyReceived) return;
      session.ready = true;
      this.state = 'ready';
      session.load.finish();
    };
    try {
      const player = this.factory(host, {
        videoId,
        width: 480,
        height: 270,
        playerVars: { origin: this.origin, autoplay: 0, controls: 1, playsinline: 1 },
        events: {
          onReady: () => {
            readyReceived = true;
            markReady();
          },
          onStateChange: ({ data }) => {
            if (!current() || !session.ready) return;
            const states: Record<number, YouTubeStatus> = {
              [-1]: 'ready',
              0: 'ended',
              1: 'playing',
              2: 'paused',
              3: 'buffering',
              5: 'ready',
            };
            if (states[data]) this.state = states[data];
            if (data === 1) {
              this.lastError = null;
              session.play?.finish();
              session.play = null;
            } else if (data === 0 || data === 2) {
              session.play?.finish(
                new YouTubeProviderError(
                  'cancelled',
                  'YouTube playback stopped before it started.',
                ),
              );
              session.play = null;
            }
          },
          onError: ({ data }) => {
            if (current()) this.fail(session, sdkError(data));
          },
          onAutoplayBlocked: () => {
            if (!current()) return;
            const error = new YouTubeProviderError(
              'autoplay-blocked',
              'YouTube playback was blocked. Press Play in the visible YouTube player or try playback again.',
            );
            session.play?.finish(error);
            session.play = null;
            this.state = 'blocked';
            this.report(error);
          },
        },
      });
      // A factory may report an error synchronously while constructing its player.
      if (current()) {
        session.player = player;
        markReady();
      } else player.destroy();
    } catch {
      this.fail(
        session,
        new YouTubeProviderError(
          'playback-failed',
          'The YouTube player could not start in this environment. Reopen the player and try again.',
        ),
      );
    }
    return session.load.promise;
  }

  play(): Promise<void> {
    const session = this.session;
    if (!session?.ready || !session.player)
      return Promise.reject(
        new YouTubeProviderError(
          'not-ready',
          'Load a YouTube video and wait for the visible player to become ready.',
        ),
      );
    if (session.play) return session.play.promise;
    if (this.playing) return Promise.resolve();
    this.lastError = null;
    const operation = this.pending(() =>
      this.fail(
        session,
        new YouTubeProviderError(
          'timeout',
          'YouTube playback did not start. Reopen the video and press Play in its visible player.',
        ),
      ),
    );
    session.play = operation;
    try {
      session.player.playVideo();
    } catch {
      this.fail(session, sdkError());
    }
    return operation.promise;
  }

  pause() {
    const session = this.session;
    if (!session?.ready || !session.player) return;
    session.play?.finish(
      new YouTubeProviderError('cancelled', 'YouTube playback was paused before it started.'),
    );
    session.play = null;
    try {
      session.player.pauseVideo();
    } catch {
      this.fail(session, sdkError());
    }
  }

  seek(seconds: number) {
    if (!Number.isFinite(seconds)) throw new RangeError('YouTube seek position must be finite.');
    const session = this.session;
    if (!session?.ready || !session.player)
      throw new YouTubeProviderError('not-ready', 'Load a YouTube video before seeking.');
    const duration = this.duration;
    if (this.session !== session) return;
    const position = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    try {
      session.player.seekTo(position, true);
    } catch {
      this.fail(session, sdkError());
    }
  }

  dispose() {
    if (this.state === 'disposed') return;
    this.close(new YouTubeProviderError('cancelled', 'The YouTube player was closed.'));
    this.state = 'disposed';
    this.lastError = null;
    this.listeners.clear();
  }

  private readClock(method: 'getCurrentTime' | 'getDuration') {
    const session = this.session;
    if (!session?.ready || !session.player) return 0;
    try {
      const value = session.player[method]();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      this.fail(session, sdkError());
      return 0;
    }
  }

  private pending(onTimeout: () => void): PendingOperation {
    let resolve!: () => void, reject!: (error: YouTubeProviderError) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(onTimeout, this.timeoutMs);
    return {
      promise,
      finish: (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      },
    };
  }

  private close(error: YouTubeProviderError) {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.load.finish(error);
    session.play?.finish(error);
    try {
      session.player?.destroy();
    } catch {
      this.report(
        new YouTubeProviderError(
          'playback-failed',
          'YouTube player cleanup failed. Reopen its browsing context.',
        ),
      );
    }
  }

  private fail(session: PlayerSession, error: YouTubeProviderError) {
    if (this.session !== session) return;
    this.close(error);
    this.state = 'error';
    this.report(error);
  }

  private report(error: YouTubeProviderError) {
    this.lastError = error;
    for (const listener of this.listeners) listener(error);
  }
}

function sdkError(sdkCode?: number): YouTubeProviderError {
  const errors: Record<number, [YouTubeErrorCode, string]> = {
    2: ['invalid-source', 'YouTube rejected this video ID. Choose another valid YouTube video.'],
    5: [
      'playback-failed',
      'YouTube HTML5 playback failed. Try another video or reopen the player in a supported environment.',
    ],
    100: [
      'unavailable',
      'This YouTube video is unavailable, removed or private. Choose an available public video.',
    ],
    101: [
      'embedding-disabled',
      'The owner disabled embedded YouTube playback. Choose another video or open it on YouTube.',
    ],
    150: [
      'embedding-disabled',
      'The owner disabled embedded YouTube playback. Choose another video or open it on YouTube.',
    ],
    153: [
      'client-identification',
      'YouTube requires HTTP Referer or equivalent client identification. Reopen the player in a correctly identified environment.',
    ],
  };
  const [code, message] = errors[sdkCode ?? -1] ?? [
    'playback-failed',
    'YouTube playback failed. Check the connection and try reopening the video.',
  ];
  return new YouTubeProviderError(code, message, sdkCode);
}

export function parseYouTubeVideoId(source: string): string {
  const input = source.trim();
  if (videoIdPattern.test(input)) return input;
  const invalid = () =>
    new YouTubeProviderError(
      'invalid-source',
      'Enter a supported HTTPS YouTube video URL or 11-character video ID.',
    );
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid();
  let id: string | undefined;
  if (url.hostname === 'youtu.be') id = /^\/([^/]+)$/.exec(url.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1)
      id = url.searchParams.get('v') ?? undefined;
    else id = /^\/(?:embed|shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1];
  }
  if (!id || !videoIdPattern.test(id)) throw invalid();
  return id;
}
