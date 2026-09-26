// @ts-nocheck
import type { StreamingAnalysisService } from '../application/live-contracts';
import {
  validateCaptureSession,
  type LiveWorkerRequest,
  type LiveWorkerResponse,
} from './live-protocol';

/** Only bounded messages cross the UI; PCM validation/DSP runs inside the worker. */
export function createStreamingAnalysisService(
  factory: () => Worker = () =>
    new Worker(new URL('./live-worker.ts', import.meta.url), { type: 'module' }),
): StreamingAnalysisService {
  return {
    open(session, update, error) {
      validateCaptureSession(session);
      const worker = factory();
      let closed = false,
        nextRequest = 0,
        generation = 0;
      let pending: {
        requestId: number;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      } | null = null;
      const release = (reason: Error) => {
        if (closed) return;
        closed = true;
        clearTimeout(initialization);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(reason);
          pending = null;
        }
      };
      const fail = (reason: Error) => {
        if (closed) return;
        release(reason);
        error(reason);
      };
      const initialization = setTimeout(
        () => fail(new Error('Live audio worker did not initialize')),
        5000,
      );
      worker.onmessage = (event: MessageEvent<LiveWorkerResponse>) => {
        const message = event.data;
        if (closed || message.captureId !== session.captureId) return;
        if (message.kind === 'ready') clearTimeout(initialization);
        else if (message.kind === 'ack' && message.requestId === pending?.requestId) {
          clearTimeout(pending.timer);
          const resolve = pending.resolve;
          pending = null;
          resolve();
        } else if (message.kind === 'update' && message.generation === generation)
          update(message.update);
        else if (message.kind === 'error') fail(new Error(message.message));
      };
      worker.onerror = () => fail(new Error('Live audio worker stopped unexpectedly'));
      const send = (message: LiveWorkerRequest, transfer: Transferable[] = []) =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            reject(new Error('Live analysis is closed'));
            return;
          }
          if (pending) {
            reject(new Error('Await the previous live audio operation'));
            return;
          }
          if (message.kind === 'open') {
            reject(new Error('Invalid live operation'));
            return;
          }
          pending = {
            requestId: message.requestId,
            resolve,
            reject,
            timer: setTimeout(
              () => fail(new Error('Live audio worker did not consume its block')),
              5000,
            ),
          };
          try {
            worker.postMessage(message, transfer);
          } catch (cause) {
            fail(cause instanceof Error ? cause : new Error('Live PCM transfer failed'));
          }
        });
      try {
        worker.postMessage({ kind: 'open', session } satisfies LiveWorkerRequest);
      } catch (cause) {
        release(new Error('Could not start live audio worker'));
        throw cause;
      }
      return {
        push(block) {
          if (closed) return Promise.reject(new Error('Live analysis is closed'));
          if (pending) return Promise.reject(new Error('Await the previous live audio operation'));
          if (
            block.captureId !== session.captureId ||
            !(block.samples instanceof Float32Array) ||
            block.samples.byteLength > 7680 ||
            block.samples.byteOffset !== 0 ||
            block.samples.buffer.byteLength !== block.samples.byteLength
          )
            return Promise.reject(new Error('Invalid live PCM transfer'));
          return send(
            { kind: 'push', captureId: session.captureId, requestId: ++nextRequest, block },
            [block.samples.buffer],
          );
        },
        reset(reason) {
          if (closed) return Promise.reject(new Error('Live analysis is closed'));
          if (pending) return Promise.reject(new Error('Await the previous live audio operation'));
          return send({
            kind: 'reset',
            captureId: session.captureId,
            requestId: ++nextRequest,
            generation: ++generation,
            reason: reason.slice(0, 200),
          });
        },
        close() {
          release(new Error('Live analysis is closed'));
        },
      };
    },
  };
}
