// @ts-nocheck
import type {
  CaptureSession,
  CaptureSource,
  LiveAnalysisUpdate,
  PcmCaptureService,
  StreamingAnalysisService,
  StreamingAnalysisSession,
} from './live-contracts';

export interface LiveSessionState {
  status:
    'idle' | 'starting' | 'listening' | 'waiting' | 'silence' | 'stopping' | 'ended' | 'error';
  sources: CaptureSource[];
  selectedSourceId: string | null;
  refreshing: boolean;
  error: string | null;
  update: LiveAnalysisUpdate | null;
  session: CaptureSession | null;
}

/** Coordinates capture and one backpressured analysis worker; owns no audio storage. */
export class LiveSessionController {
  private state: LiveSessionState = {
    status: 'idle',
    sources: [],
    selectedSourceId: null,
    refreshing: false,
    error: null,
    update: null,
    session: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private discovery = 0;
  private transition: Promise<void> = Promise.resolve();
  private analysis: StreamingAnalysisSession | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPacket = 0;
  private stalled = false;
  private disposed = false;

  constructor(
    private dependencies: {
      capture: PcmCaptureService;
      analyzer: StreamingAnalysisService;
      beforeStart(): void;
    },
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<LiveSessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async refreshSources() {
    if (this.disposed) return;
    const request = ++this.discovery;
    this.set({ refreshing: true });
    try {
      const sources = await this.dependencies.capture.sources();
      if (this.disposed || request !== this.discovery) return;
      const selected = sources.some((s) => s.id === this.state.selectedSourceId && s.available)
        ? this.state.selectedSourceId
        : null;
      this.set({ sources, selectedSourceId: selected, refreshing: false, error: null });
    } catch (error) {
      if (!this.disposed && request === this.discovery)
        this.set({ refreshing: false, error: this.message(error) });
    }
  }
  selectSource(id: string) {
    if (this.disposed || !this.state.sources.some((source) => source.id === id && source.available))
      return;
    if (id === this.state.selectedSourceId) return;
    if (this.state.session || this.state.status === 'starting') void this.stop();
    this.set({ selectedSourceId: id, error: null });
  }
  clearError() {
    this.set({ error: null });
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const sourceId = this.state.selectedSourceId;
    if (
      !sourceId ||
      !this.state.sources.some((source) => source.id === sourceId && source.available)
    ) {
      this.set({ error: 'Choose an available application or system output first.' });
      return Promise.resolve();
    }
    const generation = ++this.generation;
    this.clearWorker();
    this.set({ status: 'starting', error: null, update: null });
    return this.enqueue(async () => {
      let activated = false;
      try {
        await this.releaseNative();
        if (generation !== this.generation) return;
        this.dependencies.beforeStart();
        const session = await this.dependencies.capture.start(sourceId);
        activated = true;
        this.set({ session });
        if (generation !== this.generation) {
          await this.releaseNative();
          return;
        }
        this.set({ status: 'waiting' });
        this.lastPacket = performance.now();
        this.stalled = false;
        this.analysis = this.dependencies.analyzer.open(
          session,
          (value) => {
            if (generation !== this.generation || value.captureId !== session.captureId) return;
            this.set({
              update: value,
              status: value.signal === 'audio' ? 'listening' : value.signal,
            });
          },
          (error) => {
            if (generation === this.generation) void this.terminate('error', this.message(error));
          },
        );
        if (generation !== this.generation) {
          this.clearWorker();
          return;
        }
        void this.pull(generation, session);
      } catch (error) {
        if (generation === this.generation) {
          this.clearWorker();
          let message = this.message(error);
          if (activated) {
            try {
              await this.releaseNative();
            } catch (failure) {
              message += ` ${this.message(failure)}`;
            }
          }
          this.set({ status: 'error', update: null, error: message });
        }
      }
    });
  }
  stop(): Promise<void> {
    ++this.generation;
    this.clearWorker();
    this.set({ status: 'stopping', update: null });
    const generation = this.generation;
    return this.enqueue(async () => {
      try {
        await this.releaseNative();
        if (generation === this.generation) this.set({ status: 'idle' });
      } catch (error) {
        if (generation === this.generation)
          this.set({ status: 'error', error: this.message(error) });
      }
    });
  }
  dispose() {
    this.disposed = true;
    ++this.discovery;
    void this.stop();
    this.listeners.clear();
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.transition.then(action);
    this.transition = next.catch(() => {});
    return next;
  }
  private clearWorker() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.analysis?.close();
    this.analysis = null;
  }
  private async releaseNative() {
    const session = this.state.session;
    if (!session) return;
    await this.dependencies.capture.stop(session.captureId);
    if (this.state.session?.captureId === session.captureId) this.set({ session: null });
  }
  private async terminate(status: 'ended' | 'error', error: string) {
    const generation = ++this.generation;
    this.clearWorker();
    this.set({ status, error, update: null });
    await this.enqueue(async () => {
      try {
        await this.releaseNative();
      } catch (failure) {
        if (generation === this.generation)
          this.set({ status: 'error', error: this.message(failure) });
      }
    });
  }
  private async pull(generation: number, session: CaptureSession) {
    try {
      const batch = await this.dependencies.capture.read(session.captureId);
      if (generation !== this.generation) return;
      if (batch.captureId !== session.captureId)
        throw new Error('Capture identity changed unexpectedly.');
      if (batch.status !== 'capturing') {
        void this.terminate(
          batch.status === 'error' ? 'error' : 'ended',
          batch.error ?? 'The selected audio source stopped.',
        );
        return;
      }
      for (const block of batch.blocks) {
        if (generation !== this.generation || !this.analysis) return;
        this.lastPacket = performance.now();
        this.stalled = false;
        await this.analysis.push(block);
      }
      if (generation !== this.generation) return;
      if (!this.stalled && performance.now() - this.lastPacket >= 1000) {
        this.stalled = true;
        await this.analysis?.reset('No accessible audio packets');
        if (generation !== this.generation) return;
        this.set({ status: 'waiting', update: null });
      }
      this.timer = setTimeout(() => {
        void this.pull(generation, session);
      }, 20);
    } catch (error) {
      if (generation === this.generation) void this.terminate('error', this.message(error));
    }
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
