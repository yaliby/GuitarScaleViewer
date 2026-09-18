const DEBUG_FLAG_KEY = 'gsv_debug_log';
const RING_LIMIT = 400;

export type TraceLevel = 'start' | 'ok' | 'skip' | 'fail' | 'decide' | 'info';

export type TraceRecord = {
  t: number;
  seq: number;
  scope: string;
  event: string;
  level: TraceLevel;
  message: string;
  detail?: Record<string, unknown>;
};

let seq = 0;
let snapshot: readonly TraceRecord[] = [];
const listeners = new Set<() => void>();

/**
 * Pipeline tracing is genuinely useful while chasing a bad key resolution, and genuinely noise
 * in a shipped build. Console output stays on in `vite dev` and can be switched on in a packaged
 * app with `localStorage.gsv_debug_log = '1'`. The in-memory ring always records so the
 * Engineering drawer can show the last run even when the console is quiet.
 */
function consoleEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    if (window.localStorage.getItem(DEBUG_FLAG_KEY) === '1') {
      return true;
    }
  } catch {
    // Storage can be blocked; fall through to the build-time flag.
  }
  // Vitest runs with DEV set; pipeline traces would drown the reporter output.
  return import.meta.env.DEV === true && import.meta.env.MODE !== 'test';
}

function emitToListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function pushRecord(record: TraceRecord): void {
  const next = snapshot.concat(record);
  snapshot = next.length > RING_LIMIT ? next.slice(next.length - RING_LIMIT) : next;
  emitToListeners();
}

export function formatTraceLine(record: Pick<TraceRecord, 'seq' | 'scope' | 'event' | 'level' | 'message'>): string {
  const seqLabel = String(record.seq).padStart(4, '0');
  return `[GSV #${seqLabel} ${record.scope}] ${record.event}  ${record.message}`;
}

export function getTraceBuffer(): readonly TraceRecord[] {
  return snapshot;
}

export function subscribeTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearTraceBuffer(): void {
  snapshot = [];
  emitToListeners();
}

export function newTraceRun(label: string): string {
  const id = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  trace('boot', 'run.start', `New diagnostic run ${id}`, { runId: id, label }, 'start');
  return id;
}

export function trace(
  scope: string,
  event: string,
  message: string,
  detail?: Record<string, unknown>,
  level: TraceLevel = 'info',
): void {
  seq += 1;
  const record: TraceRecord = {
    t: Date.now(),
    seq,
    scope,
    event,
    level,
    message,
    detail,
  };
  pushRecord(record);
  if (!consoleEnabled()) {
    return;
  }
  const line = formatTraceLine(record);
  if (detail === undefined) {
    if (level === 'fail') {
      console.warn(line);
    } else {
      console.info(line);
    }
    return;
  }
  if (level === 'fail') {
    console.warn(line, detail);
  } else {
    console.info(line, detail);
  }
}

/**
 * Older call sites. Prefer `trace(scope, event, message, detail)` — the scoped form is what
 * makes a failure searchable in a long run.
 */
export function debugLog(message: string, detail?: unknown): void {
  if (detail === undefined) {
    trace('app', 'log', message);
    return;
  }
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    trace('app', 'log', message, detail as Record<string, unknown>);
    return;
  }
  trace('app', 'log', message, { detail });
}
