import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { DetectedKeyAbState, DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import {
  clearTraceBuffer,
  formatTraceDump,
  getTraceBuffer,
  subscribeTrace,
  type TraceLevel,
  type TraceRecord,
} from '../services/debugLog';
import type { FusedKey } from '../services/keyFusion';
import {
  abLine,
  captureModeLabel,
  certaintyLabel,
  detectionReasonLabel,
  detectionStateLabel,
  mediaPlaybackDisplayLabel,
  resolutionStateLabel,
} from './statusLabels';
import { GearButton, GearInput, GearSelect, Led, Legend, Seam } from './gear';

/** Minimal surface of useCloudKeyResolution that the drawer reads. */
type CloudResolution = {
  cloudState: string;
  cloudError: string | null;
  cloudHit: { verified: boolean; sourceLabel: string; source: string } | null;
  resolutionState: string;
  sourceBadge: string;
  trackIdentity: string | null;
};

export type DevDrawerProps = {
  open: boolean;
  onClose: () => void;
  mediaSession: MediaSessionUiState;
  detected: DetectedKeyState;
  detectedKeyAb: DetectedKeyAbState | null;
  cloudResolution: CloudResolution;
  activeDisplayName: string | null;
  /** What the pipeline settled on, and on what evidence. See services/keyFusion. */
  fused: FusedKey;
  /** Is the Apply latch engaged? Off means the neck is frozen wherever it stands. */
  applyDetected: boolean;
  devMockEnabled: boolean;
  onDevMockEnabledChange: (value: boolean) => void;
  devMockTitle: string;
  onDevMockTitleChange: (value: string) => void;
  devMockArtist: string;
  onDevMockArtistChange: (value: string) => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-4 py-3.5">
      <Legend className="mb-2.5 block">{title}</Legend>
      {children}
    </section>
  );
}

/** One telemetry line. Values are monospaced so columns of readings stay scannable. */
function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'fault' | 'ok' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-[11px] text-gear-engrave">{label}</span>
      <span
        className={`tele min-w-0 truncate text-right font-mono text-[11px] ${
          tone === 'fault' ? 'text-led-fault' : tone === 'ok' ? 'text-led-live' : 'text-gear-text/85'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function levelTone(level: TraceLevel): 'fault' | 'ok' | undefined {
  if (level === 'fail') {
    return 'fault';
  }
  if (level === 'ok') {
    return 'ok';
  }
  return undefined;
}

function ledForLevel(level: TraceLevel): 'fault' | 'live' | 'hold' | 'data' {
  if (level === 'fail') {
    return 'fault';
  }
  if (level === 'ok') {
    return 'live';
  }
  if (level === 'skip') {
    return 'hold';
  }
  return 'data';
}

function copyTraceDump(rows: readonly TraceRecord[]): void {
  const text = formatTraceDump(rows);
  if (text.length === 0) {
    return;
  }
  void navigator.clipboard?.writeText(text);
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[11px] text-gear-text/85">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="gear-well flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px]">
        <Led tone={checked ? 'live' : 'off'} size={7} />
      </span>
      {children}
    </label>
  );
}

function TraceLogReader({
  rows,
  onBack,
}: {
  rows: readonly TraceRecord[];
  onBack: () => void;
}) {
  const [scopeFilter, setScopeFilter] = useState('all');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scopes = [...new Set(rows.map((row) => row.scope))];
  const visible = scopeFilter === 'all' ? rows : rows.filter((row) => row.scope === scopeFilter);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [visible.length, scopeFilter]);

  const last = rows.length === 0 ? null : rows[rows.length - 1];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-4 py-3">
        <p className="text-[10px] leading-relaxed text-gear-engrave">
          Oldest first, newest at the bottom. Failures are red. Each line carries the payload the
          decision was made with.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <GearButton onClick={onBack}>Back</GearButton>
          <GearButton onClick={() => copyTraceDump(visible)} disabled={visible.length === 0}>
            Copy
          </GearButton>
          <GearButton onClick={() => clearTraceBuffer()} disabled={rows.length === 0}>
            Clear
          </GearButton>
          {scopes.length > 1 ? (
            <GearSelect
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              aria-label="Filter log by scope"
              className="min-w-[7.5rem]"
            >
              <option value="all">all scopes</option>
              {scopes.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </GearSelect>
          ) : null}
        </div>
        <p className="tele text-[10px] text-gear-engrave">
          {visible.length} {visible.length === 1 ? 'line' : 'lines'}
          {last ? ` · last ${last.scope}/${last.event}` : ''}
        </p>
      </div>
      <Seam />
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {visible.length === 0 ? (
          <p className="px-1 py-3 text-[11px] text-gear-engrave">
            No lines yet. Play a track or trigger a lookup, then this page fills in as the pipeline
            decides.
          </p>
        ) : (
          <ol className="space-y-2">
            {visible.map((row) => (
              <li key={row.seq} className="gear-well select-text rounded-[4px] p-2">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <Led tone={ledForLevel(row.level)} size={5} />
                  <span className="tele shrink-0 text-[9px] text-gear-engrave">
                    {new Date(row.t).toLocaleTimeString()} #{String(row.seq).padStart(4, '0')}
                  </span>
                  <span className="tele shrink-0 text-[9px] uppercase tracking-[0.12em] text-gear-legend">
                    {row.scope}
                  </span>
                  <span className="tele min-w-0 break-all text-[9px] text-gear-engrave">{row.event}</span>
                </div>
                <p
                  className={`mt-1 text-[12px] leading-snug ${
                    levelTone(row.level) === 'fault'
                      ? 'text-led-fault'
                      : levelTone(row.level) === 'ok'
                        ? 'text-led-live'
                        : 'text-gear-text/90'
                  }`}
                >
                  {row.message}
                </p>
                {row.detail ? (
                  <pre className="tele mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-gear-engrave">
                    {JSON.stringify(row.detail, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * Engineering panel. Everything here is diagnostics or a lab switch — none of it belongs on the
 * main face, so it lives behind a latch and slides out over the app.
 */
export function DevDrawer({
  open,
  onClose,
  mediaSession,
  detected,
  detectedKeyAb,
  cloudResolution,
  activeDisplayName,
  fused,
  applyDetected,
  devMockEnabled,
  onDevMockEnabledChange,
  devMockTitle,
  onDevMockTitleChange,
  devMockArtist,
  onDevMockArtistChange,
}: DevDrawerProps) {
  const [logOpen, setLogOpen] = useState(false);

  const pipeline = useSyncExternalStore(subscribeTrace, getTraceBuffer, getTraceBuffer);

  useEffect(() => {
    if (!open) {
      setLogOpen(false);
    }
  }, [open]);
  const cloudLookupLine =
    cloudResolution.cloudState === 'hit'
      ? 'verified key found'
      : cloudResolution.cloudState === 'miss'
        ? 'not in the library, local fallback'
        : 'idle';

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/55"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            className={`gear-brushed fixed right-0 top-0 z-50 flex h-full flex-col shadow-[-16px_0_48px_-12px_rgba(0,0,0,0.85)] ${
              logOpen ? 'w-[min(40rem,100vw)]' : 'w-[min(26rem,100vw)]'
            }`}
            style={{ boxShadow: '-16px 0 48px -12px rgba(0,0,0,0.85), inset 1px 0 0 rgba(255,255,255,0.07)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            role="dialog"
            aria-label={logOpen ? 'Pipeline log' : 'Engineering panel'}
          >
            <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2">
                <Led tone="data" size={6} />
                <span className="text-[12px] font-bold uppercase tracking-[0.2em] text-gear-legend">
                  {logOpen ? 'Pipeline log' : 'Engineering'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {logOpen ? null : (
                  <GearButton
                    onClick={() => setLogOpen(true)}
                    aria-label={pipeline.length > 0 ? `Log ${pipeline.length}` : 'Log'}
                    title="Read the pipeline log"
                  >
                    Log{pipeline.length > 0 ? ` ${pipeline.length}` : ''}
                  </GearButton>
                )}
                <GearButton onClick={onClose} aria-label="Close engineering panel">
                  Close
                </GearButton>
              </div>
            </header>
            <Seam />

            {logOpen ? (
              <TraceLogReader rows={pipeline} onBack={() => setLogOpen(false)} />
            ) : (
            <div className="min-h-0 flex-1 divide-y divide-black/50 overflow-y-auto">
              <Section title="Signal">
                <Row label="Now playing" value={[mediaSession.artist, mediaSession.title].filter(Boolean).join(' — ') || '—'} />
                <Row label="Playback" value={mediaPlaybackDisplayLabel(mediaSession.playbackStatus)} />
                <Row label="Source app" value={mediaSession.sourceApp ?? '—'} />
                <Row label="Capture" value={captureModeLabel(detected.captureMode)} />
                <Row label="Target" value={detected.targetApp ?? '—'} />
              </Section>

              <Section title="Detection">
                <Row label="Key" value={activeDisplayName ?? '—'} />
                <Row label="State" value={detectionStateLabel(detected.state)} />
                <Row label="Resolution" value={resolutionStateLabel(cloudResolution.resolutionState)} />
                <Row label="Badge" value={cloudResolution.sourceBadge} />
                <Row label="Confidence" value={`${Math.round(detected.confidence * 100)}%`} />
                <Row label="Stability" value={`${Math.round(detected.stability * 100)}%`} />
                <Row label="Windows" value={detected.windowCount} />
                <Row label="Buffer" value={`${detected.bufferSeconds.toFixed(1)}s / 12s`} tone={detected.enoughAudio ? 'ok' : undefined} />
                {detected.alternatives.length > 0 ? (
                  <Row
                    label="Alternatives"
                    value={detected.alternatives
                      .slice(0, 2)
                      .map((alt) => `${alt.displayName} ${Math.round(alt.confidence * 100)}%`)
                      .join(' · ')}
                  />
                ) : null}
                <Row label="Library lookup" value={cloudLookupLine} />
                {!fused.root ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-led-hold/85">
                    Nothing on the neck yet: {detectionReasonLabel(detected.reason)}
                  </p>
                ) : null}
              </Section>

              <Section title="Pipeline log">
                <p className="mb-2 text-[10px] leading-relaxed text-gear-engrave">
                  Every decision in this run, with the payload it was made on. Open the reader for
                  the full sequence. The same lines go to the browser console as
                  <span className="tele"> [GSV]</span>.
                </p>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <GearButton tone="primary" onClick={() => setLogOpen(true)}>
                    Read log
                  </GearButton>
                  <GearButton onClick={() => copyTraceDump(pipeline)} disabled={pipeline.length === 0}>
                    Copy
                  </GearButton>
                  <GearButton onClick={() => clearTraceBuffer()} disabled={pipeline.length === 0}>
                    Clear
                  </GearButton>
                </div>
                <p className="tele text-[10px] text-gear-engrave">
                  {pipeline.length === 0
                    ? 'No lines yet. Play a track or trigger a lookup.'
                    : `${pipeline.length} ${pipeline.length === 1 ? 'line' : 'lines'} · last ${pipeline[pipeline.length - 1]?.scope}/${pipeline[pipeline.length - 1]?.event}`}
                </p>
              </Section>

              <Section title="Analyzer A/B">
                {detectedKeyAb ? (
                  <>
                    <Row label="Current" value={abLine('', detectedKeyAb.current).replace(/^:\s*/, '')} />
                    <Row label="LibKeyFinder" value={abLine('', detectedKeyAb.libkeyfinder).replace(/^:\s*/, '')} />
                  </>
                ) : (
                  <p className="text-[11px] text-gear-engrave">Waiting for A/B data. Enable with KEY_ANALYZER_AB=1.</p>
                )}
              </Section>

              <Section title="Key on the neck">
                {/* There is no threshold and no latch to show here any more: the pipeline
                    always commits to its best answer. Verified transcription outranks the
                    engine; otherwise the engine is what you hear. */}
                <Row label="Key" value={fused.displayName ?? '<none>'} />
                <Row label="Certainty" value={`${certaintyLabel(fused.certainty)} · ${fused.confidencePct}%`} />
                <Row label="Scale tones" value={fused.notesSettled ? 'corroborated' : 'one estimator only'} />
                <Row
                  label="Tonic"
                  value={
                    fused.tonicSettled
                      ? 'no rival reading'
                      : `open — also reads as ${fused.relativeAlternative ?? 'its relative'}`
                  }
                />
                <Row label="Decided by" value={fused.why} />
                {applyDetected ? null : (
                  <p className="mt-2 text-[11px] leading-relaxed text-led-hold/85">
                    Apply is off: the song is still being analysed, but the neck is being held where it is.
                  </p>
                )}
              </Section>

              {import.meta.env.DEV ? (
                <Section title="Library test bench">
                  <Check checked={devMockEnabled} onChange={onDevMockEnabledChange}>
                    Use a mock track for library lookup
                  </Check>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <GearInput value={devMockTitle} onChange={(e) => onDevMockTitleChange(e.target.value)} placeholder="Title" />
                    <GearInput value={devMockArtist} onChange={(e) => onDevMockArtistChange(e.target.value)} placeholder="Artist" />
                  </div>
                  <Row label="Track identity" value={cloudResolution.trackIdentity ?? '<none>'} />
                </Section>
              ) : null}
            </div>
            )}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
