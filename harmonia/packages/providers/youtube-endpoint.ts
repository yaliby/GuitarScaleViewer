// @ts-nocheck
import { YouTubeProvider } from './youtube';
import {
  PROTOCOL,
  LEASE_MS,
  SNAPSHOT_INTERVAL_MS,
  MAX_REQUESTS_PER_SECOND,
  MAX_PENDING_REQUESTS,
  MessageBudget,
  YouTubeBridgeError,
  decodeMessage,
  encodeMessage,
  matchesPeer,
  validatePeer,
  validNonce,
  validError,
  validClock,
  type BridgeTransport,
  type BridgePeer,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeErrorCode,
  type BridgeMessage,
  type PlaybackSnapshot,
} from './youtube-bridge-protocol';

/** Runs only in the isolated player context. Factory supplies a fresh visible host per load. */
export class YouTubeBridgeEndpoint {
  private provider: YouTubeProvider | null = null;
  private unsubscribeProvider: (() => void) | null = null;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private peer: BridgePeer;
  private session: string;
  private generation: string | null = null;
  private lastId = 0;
  private sequence = 0;
  private lastContact = performance.now();
  private closed = false;
  private override: BridgeErrorCode | null = null;
  private incoming = new MessageBudget(MAX_REQUESTS_PER_SECOND);
  private pending = new Set<number>();

  constructor(
    private transport: BridgeTransport,
    options: { peer: BridgePeer; session: string },
    private createPlayer: () => { provider: YouTubeProvider; host: HTMLElement },
  ) {
    validatePeer(options.peer);
    if (!validNonce(options.session)) throw new Error('Invalid playback session binding');
    this.peer = { ...options.peer };
    this.session = options.session;
    this.unsubscribe = transport.subscribe((event) => this.receive(event));
    this.timer = setInterval(() => {
      if (this.closed || !this.generation) return;
      if (performance.now() - this.lastContact >= LEASE_MS) {
        this.close(true);
        return;
      }
      this.publish();
    }, SNAPSHOT_INTERVAL_MS);
  }
  dispose() {
    this.close(true);
  }
  private receive(event: BridgeEvent) {
    if (this.closed || !matchesPeer(event, this.peer) || !this.incoming.accept()) return;
    const request = decodeMessage(event.data);
    if (
      !request ||
      request.kind !== 'request' ||
      request.session !== this.session ||
      request.id <= this.lastId
    )
      return;
    if (request.op === 'load') {
      if (request.generation === this.generation) return;
      this.generation = request.generation;
      this.sequence = 0;
      this.override = null;
      this.stopPlayer();
      this.pending.clear();
    } else if (request.generation !== this.generation) return;
    this.lastId = request.id;
    this.lastContact = performance.now();
    if (
      this.pending.size >= MAX_PENDING_REQUESTS &&
      (request.op === 'play' || request.op === 'load')
    ) {
      this.reply(request, 'rate-limit');
      return;
    }
    this.pending.add(request.id);
    void this.execute(request);
  }
  private async execute(request: BridgeRequest) {
    const current = () => !this.closed && request.generation === this.generation;
    try {
      switch (request.op) {
        case 'load': {
          const { provider, host } = this.createPlayer();
          this.provider = provider;
          this.unsubscribeProvider = provider.onError(() => {
            if (current()) this.publish();
          });
          await provider.load(request.videoId, host);
          break;
        }
        case 'play':
          if (!this.provider) throw new YouTubeBridgeError('not-ready');
          await this.provider.play();
          break;
        case 'pause':
          this.provider?.pause();
          break;
        case 'seek':
          if (!this.provider) throw new YouTubeBridgeError('not-ready');
          this.provider.seek(request.seconds);
          break;
        case 'heartbeat':
          break;
        case 'dispose':
          this.stopPlayer();
          break;
      }
      if (current()) this.reply(request, null);
      if (request.op === 'dispose') this.close(false);
    } catch (error) {
      if (!current()) return;
      const code =
        typeof error === 'object' && error !== null && 'code' in error && validError(error.code)
          ? error.code
          : 'playback-failed';
      if (request.op === 'load') {
        this.stopPlayer();
        this.override = code;
      }
      this.reply(request, code);
    } finally {
      this.pending.delete(request.id);
    }
  }
  private snapshot(): PlaybackSnapshot {
    let position = this.provider?.position ?? 0,
      duration = this.provider?.duration ?? 0;
    if (!validClock(position, duration)) {
      this.stopPlayer();
      this.override = 'playback-failed';
      position = 0;
      duration = 0;
    }
    return {
      sequence: ++this.sequence,
      status: this.override ? 'error' : (this.provider?.status ?? 'disposed'),
      available: this.provider?.available ?? false,
      position,
      duration,
      error: this.override ?? this.provider?.error?.code ?? null,
    };
  }
  private publish() {
    if (!this.generation || this.closed) return;
    this.send({
      protocol: PROTOCOL,
      session: this.session,
      generation: this.generation,
      kind: 'snapshot',
      snapshot: this.snapshot(),
    });
  }
  private reply(request: BridgeRequest, error: BridgeErrorCode | null) {
    this.send({
      protocol: PROTOCOL,
      session: this.session,
      generation: request.generation,
      kind: 'reply',
      id: request.id,
      op: request.op,
      error,
      snapshot: this.snapshot(),
    });
  }
  private send(message: BridgeMessage) {
    try {
      this.transport.send(encodeMessage(message), this.peer.origin);
    } catch {
      this.close(false);
    }
  }
  private stopPlayer() {
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = null;
    const provider = this.provider;
    this.provider = null;
    provider?.pause();
    provider?.dispose();
  }
  private close(notify: boolean) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.stopPlayer();
    this.pending.clear();
    if (notify && this.generation) {
      this.override = 'offline';
      this.send({
        protocol: PROTOCOL,
        session: this.session,
        generation: this.generation,
        kind: 'snapshot',
        snapshot: this.snapshot(),
      });
    }
  }
}
