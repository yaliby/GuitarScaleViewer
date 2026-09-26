// @ts-nocheck
import type { YouTubeStatus } from './youtube';

export const PROTOCOL = 'harmonia-youtube-v1';
export const MAX_MESSAGE_BYTES = 2048;
export const MAX_PROVIDER_SECONDS = 7 * 86400;
// Separate SDK clock/duration reads can straddle a live-duration update.
export const CLOCK_TOLERANCE_SECONDS = 2;
export const SNAPSHOT_INTERVAL_MS = 250;
export const HEARTBEAT_INTERVAL_MS = 1000;
export const LEASE_MS = 5000;
export const MAX_PENDING_REQUESTS = 8;
export const MAX_REQUESTS_PER_SECOND = 32;

const errorCodes = [
  'invalid-source',
  'not-ready',
  'unavailable',
  'embedding-disabled',
  'client-identification',
  'playback-failed',
  'autoplay-blocked',
  'timeout',
  'cancelled',
  'disposed',
  'offline',
  'rate-limit',
] as const;
export type BridgeErrorCode = (typeof errorCodes)[number];
export class YouTubeBridgeError extends Error {
  constructor(readonly code: BridgeErrorCode) {
    const messages: Record<BridgeErrorCode, string> = {
      'invalid-source': 'Choose a supported public YouTube video no longer than seven days.',
      'not-ready': 'Load a YouTube video and wait for its visible player.',
      unavailable: 'This YouTube video is unavailable or private. Choose another video.',
      'embedding-disabled':
        'The owner disabled embedded playback. Choose another video or open YouTube.',
      'client-identification':
        'YouTube requires valid client identification. Reopen the configured player.',
      'playback-failed': 'The YouTube player failed. Reopen the player and try again.',
      'autoplay-blocked': 'Playback was blocked. Press Play in the visible YouTube player.',
      timeout: 'The YouTube player did not respond in time. Reopen the player.',
      cancelled: 'This YouTube playback request was cancelled.',
      disposed: 'The YouTube connection is closed. Open a new player.',
      offline:
        'The YouTube player connection was lost. Check the connection and reopen the player.',
      'rate-limit': 'Too many player requests are pending. Wait briefly and try again.',
    };
    super(messages[code]);
    this.name = 'YouTubeBridgeError';
  }
}
export interface BridgeTransport {
  send(message: string, targetOrigin: string): void;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}
export interface BridgeEvent {
  data: unknown;
  origin: string;
  source: unknown;
}
export interface BridgePeer {
  origin: string;
  source: object;
}
export interface PlaybackSnapshot {
  sequence: number;
  status: YouTubeStatus;
  available: boolean;
  position: number;
  duration: number;
  error: BridgeErrorCode | null;
}
interface Envelope {
  protocol: typeof PROTOCOL;
  session: string;
  generation: string;
}
export type PlaybackCommand =
  | { op: 'load'; videoId: string }
  | { op: 'seek'; seconds: number }
  | { op: 'play' | 'pause' | 'heartbeat' | 'dispose' };
export type BridgeRequest = Envelope & { kind: 'request'; id: number } & PlaybackCommand;
export type BridgeReply = Envelope & {
  kind: 'reply';
  id: number;
  op: PlaybackCommand['op'];
  error: BridgeErrorCode | null;
  snapshot: PlaybackSnapshot;
};
export type BridgeMessage =
  BridgeRequest | BridgeReply | (Envelope & { kind: 'snapshot'; snapshot: PlaybackSnapshot });
const operations = ['load', 'play', 'pause', 'seek', 'heartbeat', 'dispose'];
const states: YouTubeStatus[] = [
  'idle',
  'loading',
  'ready',
  'playing',
  'buffering',
  'paused',
  'ended',
  'blocked',
  'error',
  'disposed',
];
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const positiveInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export const validNonce = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const validSeconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PROVIDER_SECONDS;
export const validError = (v: unknown): v is BridgeErrorCode =>
  typeof v === 'string' && (errorCodes as readonly string[]).includes(v);
export function validClock(position: unknown, duration: unknown): boolean {
  return (
    validSeconds(position) &&
    validSeconds(duration) &&
    (duration === 0 || position <= duration + CLOCK_TOLERANCE_SECONDS)
  );
}
function validSnapshot(v: unknown): v is PlaybackSnapshot {
  return (
    record(v) &&
    exactKeys(v, ['sequence', 'status', 'available', 'position', 'duration', 'error']) &&
    positiveInteger(v.sequence) &&
    states.includes(v.status as YouTubeStatus) &&
    typeof v.available === 'boolean' &&
    validClock(v.position, v.duration) &&
    (v.error === null || validError(v.error)) &&
    (v.status === 'blocked' ||
      v.available === !['idle', 'loading', 'error', 'disposed'].includes(v.status as string)) &&
    (v.available || (v.position === 0 && v.duration === 0)) &&
    (v.status !== 'error' || v.error !== null)
  );
}
export function decodeMessage(input: unknown): BridgeMessage | null {
  if (
    typeof input !== 'string' ||
    input.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(input).length > MAX_MESSAGE_BYTES
  )
    return null;
  try {
    const v: unknown = JSON.parse(input);
    if (
      !record(v) ||
      v.protocol !== PROTOCOL ||
      !validNonce(v.session) ||
      !validNonce(v.generation)
    )
      return null;
    const base = ['protocol', 'session', 'generation', 'kind'];
    if (v.kind === 'snapshot')
      return exactKeys(v, [...base, 'snapshot']) && validSnapshot(v.snapshot)
        ? (v as unknown as BridgeMessage)
        : null;
    if (!positiveInteger(v.id) || !operations.includes(v.op as string)) return null;
    if (v.kind === 'reply')
      return exactKeys(v, [...base, 'id', 'op', 'error', 'snapshot']) &&
        (v.error === null || validError(v.error)) &&
        validSnapshot(v.snapshot)
        ? (v as unknown as BridgeReply)
        : null;
    if (v.kind !== 'request') return null;
    const keys = [...base, 'id', 'op'];
    if (v.op === 'load') {
      if (
        !exactKeys(v, [...keys, 'videoId']) ||
        typeof v.videoId !== 'string' ||
        !/^[A-Za-z0-9_-]{11}$/.test(v.videoId)
      )
        return null;
    } else if (v.op === 'seek') {
      if (!exactKeys(v, [...keys, 'seconds']) || !validSeconds(v.seconds)) return null;
    } else if (!exactKeys(v, keys)) return null;
    return v as unknown as BridgeRequest;
  } catch {
    return null;
  }
}
export function encodeMessage(value: BridgeMessage): string {
  const encoded = JSON.stringify(value);
  if (!decodeMessage(encoded)) throw new Error('Invalid playback bridge message');
  return encoded;
}
export function validatePeer(peer: BridgePeer) {
  const url = new URL(peer.origin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== peer.origin ||
    !peer.source ||
    typeof peer.source !== 'object'
  )
    throw new Error('Playback bridge requires an exact nonopaque origin and source object');
}
export function matchesPeer(event: BridgeEvent, peer: BridgePeer) {
  return event.origin === peer.origin && event.source === peer.source;
}
export class MessageBudget {
  private start = performance.now();
  private count = 0;
  constructor(private readonly limit: number) {}
  accept() {
    const now = performance.now();
    if (now - this.start >= 1000) {
      this.start = now;
      this.count = 0;
    }
    return ++this.count <= this.limit;
  }
}
