// @ts-nocheck
import type { MusicProvider } from '../application/contracts';
import { parseYouTubeVideoId } from './youtube';
import {
  PROTOCOL,
  HEARTBEAT_INTERVAL_MS,
  LEASE_MS,
  MAX_PENDING_REQUESTS,
  MAX_REQUESTS_PER_SECOND,
  YouTubeBridgeError,
  MessageBudget,
  decodeMessage,
  encodeMessage,
  matchesPeer,
  validatePeer,
  validSeconds,
  type BridgeTransport,
  type BridgePeer,
  type BridgeEvent,
  type BridgeErrorCode,
  type PlaybackCommand,
  type PlaybackSnapshot,
} from './youtube-bridge-protocol';

interface Pending {
  op: PlaybackCommand['op'];
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: YouTubeBridgeError): void;
}
const emptySnapshot = (): PlaybackSnapshot => ({
  sequence: 0,
  status: 'idle',
  available: false,
  position: 0,
  duration: 0,
  error: null,
});

/** Playback-only proxy. The remote context remains untrusted despite nonce binding. */
export class YouTubeBridgeProvider implements MusicProvider {
  readonly id = 'youtube';
  readonly session = crypto.randomUUID();
  readonly capabilities = Object.freeze({
    play: true,
    pause: true,
    seek: true,
    position: true,
    duration: true,
    rawAnalysisAvailable: false,
    offlineAvailable: false,
  });
  private generation: string | null = null;
  private state = emptySnapshot();
  private lastError: YouTubeBridgeError | null = null;
  private listeners = new Set<(error: YouTubeBridgeError) => void>();
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private lastContact = performance.now();
  private timeoutMs: number;
  private peer: BridgePeer;
  private unsubscribe: () => void;
  private heartbeat: ReturnType<typeof setInterval>;
  private outgoing = new MessageBudget(MAX_REQUESTS_PER_SECOND);
  private incoming = new MessageBudget(MAX_REQUESTS_PER_SECOND * 2);

  constructor(
    private transport: BridgeTransport,
    options: { peer: BridgePeer; timeoutMs?: number },
  ) {
    validatePeer(options.peer);
    this.peer = { ...options.peer };
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120000)
      throw new Error('Invalid playback request timeout');
    this.unsubscribe = transport.subscribe((event) => this.receive(event));
    this.heartbeat = setInterval(() => {
      if (this.closed || !this.generation) return;
      if (performance.now() - this.lastContact >= LEASE_MS) {
        this.disconnect('offline');
        return;
      }
      if (![...this.pending.values()].some((request) => request.op === 'heartbeat'))
        void this.request({ op: 'heartbeat' }).catch((error) => this.notify(error));
    }, HEARTBEAT_INTERVAL_MS);
  }
  get available() {
    return this.state.available && !this.closed;
  }
  get playing() {
    return this.available && this.state.status === 'playing';
  }
  get position() {
    return this.state.position;
  }
  get duration() {
    return this.state.duration;
  }
  get status() {
    return this.state.status;
  }
  get error() {
    return this.lastError;
  }
  onError(listener: (error: YouTubeBridgeError) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  load(source: string): Promise<void> {
    if (this.closed) return Promise.reject(new YouTubeBridgeError('disposed'));
    let videoId: string;
    try {
      videoId = parseYouTubeVideoId(source);
    } catch {
      return Promise.reject(new YouTubeBridgeError('invalid-source'));
    }
    this.cancelPending('cancelled');
    this.generation = crypto.randomUUID();
    this.state = { ...emptySnapshot(), status: 'loading' };
    this.lastError = null;
    this.lastContact = performance.now();
    return this.request({ op: 'load', videoId });
  }
  play(): Promise<void> {
    if (!this.available)
      return Promise.reject(new YouTubeBridgeError(this.closed ? 'disposed' : 'not-ready'));
    const existing = [...this.pending.values()].find((request) => request.op === 'play');
    if (existing) return existing.promise;
    this.lastError = null;
    return this.request({ op: 'play' });
  }
  pause() {
    if (!this.available) return;
    this.cancelPending('cancelled', 'play');
    void this.request({ op: 'pause' }).catch((error) => this.notify(error));
  }
  seek(seconds: number) {
    if (!validSeconds(seconds)) throw new YouTubeBridgeError('invalid-source');
    if (!this.available) throw new YouTubeBridgeError(this.closed ? 'disposed' : 'not-ready');
    void this.request({ op: 'seek', seconds }).catch((error) => this.notify(error));
  }
  dispose() {
    if (!this.closed) this.disconnect('cancelled', true);
    this.state = { ...emptySnapshot(), status: 'disposed' };
    this.lastError = null;
    this.listeners.clear();
  }
  private request(command: PlaybackCommand): Promise<void> {
    if (this.closed || !this.generation) return Promise.reject(new YouTubeBridgeError('disposed'));
    if (this.pending.size >= MAX_PENDING_REQUESTS || !this.outgoing.accept())
      return Promise.reject(new YouTubeBridgeError('rate-limit'));
    const id = ++this.nextId;
    let resolve!: () => void, reject!: (error: YouTubeBridgeError) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => this.disconnect('timeout'), this.timeoutMs);
    this.pending.set(id, { op: command.op, promise, resolve, reject, timer });
    try {
      this.transport.send(
        encodeMessage({
          protocol: PROTOCOL,
          session: this.session,
          generation: this.generation,
          kind: 'request',
          id,
          ...command,
        }),
        this.peer.origin,
      );
    } catch {
      this.disconnect('offline');
    }
    return promise;
  }
  private receive(event: BridgeEvent) {
    if (this.closed || !matchesPeer(event, this.peer) || !this.incoming.accept()) return;
    const message = decodeMessage(event.data);
    if (
      !message ||
      message.kind === 'request' ||
      message.session !== this.session ||
      message.generation !== this.generation ||
      message.snapshot.sequence <= this.state.sequence
    )
      return;
    const pending = message.kind === 'reply' ? this.pending.get(message.id) : null;
    if (message.kind === 'reply' && (!pending || pending.op !== message.op)) return;
    // A play reply confirms the awaited SDK PLAYING event. Its current snapshot may
    // already be paused by the native player; never invent a newer playing state.
    if (
      message.kind === 'reply' &&
      message.error === null &&
      message.op === 'load' &&
      !message.snapshot.available
    )
      return;
    this.lastContact = performance.now();
    this.state = { ...message.snapshot };
    if (message.snapshot.error === 'offline') {
      this.disconnect('offline');
      return;
    }
    if (message.snapshot.error) this.notify(new YouTubeBridgeError(message.snapshot.error));
    else this.lastError = null;
    if (message.kind === 'reply' && pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new YouTubeBridgeError(message.error);
        pending.reject(error);
        this.notify(error);
      } else pending.resolve();
    }
  }
  private cancelPending(code: BridgeErrorCode, op?: PlaybackCommand['op']) {
    for (const [id, pending] of this.pending) {
      if (op && pending.op !== op) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new YouTubeBridgeError(code));
    }
  }
  private disconnect(code: BridgeErrorCode, disposing = false) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.cancelPending(code);
    if (this.generation) {
      try {
        this.transport.send(
          encodeMessage({
            protocol: PROTOCOL,
            session: this.session,
            generation: this.generation,
            kind: 'request',
            id: ++this.nextId,
            op: 'dispose',
          }),
          this.peer.origin,
        );
      } catch {
        /* The endpoint lease independently disposes disconnected playback. */
      }
    }
    this.state = {
      ...emptySnapshot(),
      status: disposing ? 'disposed' : 'error',
      error: disposing ? null : code,
    };
    if (!disposing) this.notify(new YouTubeBridgeError(code));
  }
  private notify(error: YouTubeBridgeError) {
    if (this.closed && this.state.status === 'disposed') return;
    if (this.lastError?.code === error.code) return;
    this.lastError = error;
    for (const listener of this.listeners) listener(error);
  }
}
