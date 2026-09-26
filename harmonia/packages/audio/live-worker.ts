// @ts-nocheck
import { StreamingChordEngine } from './live-engine';
import type { LiveWorkerRequest, LiveWorkerResponse } from './live-protocol';
import type { LiveAnalysisUpdate } from '../application/live-contracts';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<LiveWorkerRequest>) => void;
  postMessage: (message: LiveWorkerResponse) => void;
  close: () => void;
};
let engine: StreamingChordEngine | null = null,
  captureId = '';
let pending: LiveAnalysisUpdate | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSent = -Infinity;
let generation = 0;
function publish(update: LiveAnalysisUpdate) {
  pending = update;
  if (timer !== null) return;
  const send = () => {
    timer = null;
    if (pending) {
      scope.postMessage({ kind: 'update', captureId, generation, update: pending });
      pending = null;
      lastSent = performance.now();
    }
  };
  const remaining = 100 - (performance.now() - lastSent);
  if (remaining <= 0) send();
  else timer = setTimeout(send, remaining);
}
scope.onmessage = (event) => {
  try {
    const message = event.data;
    if (message.kind === 'open') {
      if (engine) throw new Error('Live worker is already open');
      captureId = message.session.captureId;
      engine = new StreamingChordEngine(message.session);
      scope.postMessage({ kind: 'ready', captureId });
      publish(engine.snapshot());
      return;
    }
    if (
      !engine ||
      message.captureId !== captureId ||
      !Number.isSafeInteger(message.requestId) ||
      message.requestId < 1
    )
      throw new Error('Invalid live worker request');
    if (message.kind === 'push') publish(engine.push(message.block));
    else if (
      message.kind === 'reset' &&
      message.generation === generation + 1 &&
      typeof message.reason === 'string' &&
      message.reason.length <= 200
    ) {
      generation = message.generation;
      publish(engine.reset(message.reason));
    } else throw new Error('Unknown live worker operation');
    scope.postMessage({ kind: 'ack', captureId, requestId: message.requestId });
  } catch (cause) {
    if (timer !== null) clearTimeout(timer);
    pending = null;
    engine?.close();
    scope.postMessage({
      kind: 'error',
      captureId,
      message: cause instanceof Error ? cause.message : 'Live audio failed',
    });
    scope.close();
  }
};
