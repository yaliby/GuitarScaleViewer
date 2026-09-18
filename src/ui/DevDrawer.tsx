import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { DetectedKeyAbState, DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import {
  clearTraceBuffer,
  formatTraceLine,
  getTraceBuffer,
  subscribeTrace,
  type TraceLevel,
} from '../services/debugLog';
import {
  getFreqblogApiKeyForDev,
  getGetSongBpmApiKeyForDev,
  getSongKeyApiBaseForDev,
  setFreqblogApiKeyForDev,
  setGetSongBpmApiKeyForDev,
  setSongKeyApiBaseForDev,
} from '../services/songKeyApi';
import {
  abLine,
  captureModeLabel,
  detectionReasonLabel,
  detectionStateLabel,
  mediaPlaybackDisplayLabel,
  resolutionStateLabel,
} from './statusLabels';
import { GearButton, GearInput, GearSelect, Led, Legend, Seam } from './gear';
import { ROOT_NOTE_OPTIONS } from '../scaleDataProvider';

// The app can now display a flat key ("Ab major"), so the suggestion picker has to offer one.
const SUGGEST_KEYS: readonly string[] = ROOT_NOTE_OPTIONS;

/** Minimal surface of useCloudKeyResolution that the drawer reads. */
type CloudResolution = {
  cloudState: string;
  cloudError: string | null;
  cloudHit: { verified: boolean; sourceLabel: string; source: string } | null;
  resolutionState: string;
  sourceBadge: string;
  trackIdentity: string | null;
  suggestionStatus: string;
  suggestionMessage: string | null;
  submitSuggestion: (key: string, mode: 'major' | 'minor') => Promise<void> | void;
};

export type DevDrawerProps = {
  open: boolean;
  onClose: () => void;
  mediaSession: MediaSessionUiState;
  detected: DetectedKeyState;
  detectedKeyAb: DetectedKeyAbState | null;
  cloudResolution: CloudResolution;
  activeDisplayName: string | null;
  canApply: boolean;
  autoApplyEnabled: boolean;
  onAutoApplyEnabledChange: (value: boolean) => void;
  autoApplyConfidencePct: number;
  onAutoApplyConfidencePctChange: (value: number) => void;
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
  canApply,
  autoApplyEnabled,
  onAutoApplyEnabledChange,
  autoApplyConfidencePct,
  onAutoApplyConfidencePctChange,
  devMockEnabled,
  onDevMockEnabledChange,
  devMockTitle,
  onDevMockTitleChange,
  devMockArtist,
  onDevMockArtistChange,
}: DevDrawerProps) {
  const [suggestKey, setSuggestKey] = useState('C');
  const [suggestMode, setSuggestMode] = useState<'major' | 'minor'>('major');
  const [apiBase, setApiBase] = useState(getSongKeyApiBaseForDev());
  const [freqblogKey, setFreqblogKey] = useState(getFreqblogApiKeyForDev());
  const [getSongBpmKey, setGetSongBpmKey] = useState(getGetSongBpmApiKeyForDev());

  const pipeline = useSyncExternalStore(subscribeTrace, getTraceBuffer, getTraceBuffer);
  const cloudLookupLine =
    cloudResolution.cloudState === 'lookup_pending'
      ? 'checking verified db, then catalogs'
      : cloudResolution.cloudState === 'hit'
        ? cloudResolution.cloudHit?.verified
          ? 'verified key found'
          : `catalog key (${cloudResolution.cloudHit?.sourceLabel ?? 'external'})`
        : cloudResolution.cloudState === 'miss'
          ? 'no catalog key, local fallback'
          : cloudResolution.cloudState === 'error'
            ? 'lookup failed, trying catalogs'
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
            className="gear-brushed fixed right-0 top-0 z-50 flex h-full w-[min(26rem,100vw)] flex-col shadow-[-16px_0_48px_-12px_rgba(0,0,0,0.85)]"
            style={{ boxShadow: '-16px 0 48px -12px rgba(0,0,0,0.85), inset 1px 0 0 rgba(255,255,255,0.07)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            role="dialog"
            aria-label="Engineering panel"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2">
                <Led tone="data" size={6} />
                <span className="text-[12px] font-bold uppercase tracking-[0.2em] text-gear-legend">Engineering</span>
              </div>
              <GearButton onClick={onClose} aria-label="Close engineering panel">
                Close
              </GearButton>
            </header>
            <Seam />

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
                <Row label="Cloud lookup" value={cloudLookupLine} />
                {cloudResolution.cloudError ? <Row label="Cloud error" value={cloudResolution.cloudError} tone="fault" /> : null}
                {!canApply ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-led-hold/85">
                    Apply disabled: {detectionReasonLabel(detected.reason)}
                  </p>
                ) : null}
              </Section>

              <Section title="Pipeline log">
                <p className="mb-2 text-[10px] leading-relaxed text-gear-engrave">
                  Every decision in this run. Failures are red. The same lines go to the browser console as
                  <span className="tele"> [GSV]</span>. Rust lines live in <span className="tele">gsv-dev.log</span>.
                </p>
                <div className="mb-2 flex gap-1.5">
                  <GearButton
                    onClick={() => {
                      const text = pipeline
                        .map((row) => {
                          const time = new Date(row.t).toISOString();
                          const detail = row.detail ? ` ${JSON.stringify(row.detail)}` : '';
                          return `${time} ${formatTraceLine(row)}${detail}`;
                        })
                        .join('\n');
                      void navigator.clipboard?.writeText(text);
                    }}
                    disabled={pipeline.length === 0}
                  >
                    Copy
                  </GearButton>
                  <GearButton onClick={() => clearTraceBuffer()} disabled={pipeline.length === 0}>
                    Clear
                  </GearButton>
                </div>
                {pipeline.length === 0 ? (
                  <p className="text-[11px] text-gear-engrave">No lines yet. Play a track or trigger a lookup.</p>
                ) : (
                  <ol className="gear-well max-h-64 space-y-1 overflow-y-auto rounded-[4px] p-2">
                    {[...pipeline].reverse().map((row) => (
                      <li key={row.seq} className="min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <Led tone={row.level === 'fail' ? 'fault' : row.level === 'ok' ? 'live' : row.level === 'skip' ? 'hold' : 'data'} size={5} />
                          <span className="tele shrink-0 text-[9px] text-gear-engrave">
                            {new Date(row.t).toLocaleTimeString()} #{String(row.seq).padStart(4, '0')}
                          </span>
                          <span className="tele shrink-0 text-[9px] uppercase tracking-[0.12em] text-gear-legend">
                            {row.scope}
                          </span>
                          <span className="tele shrink-0 text-[9px] text-gear-engrave">{row.event}</span>
                        </div>
                        <p
                          className={`mt-0.5 pl-3 text-[11px] leading-snug ${
                            levelTone(row.level) === 'fault'
                              ? 'text-led-fault'
                              : levelTone(row.level) === 'ok'
                                ? 'text-led-live'
                                : 'text-gear-text/85'
                          }`}
                        >
                          {row.message}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
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

              <Section title="Auto apply">
                <Check checked={autoApplyEnabled} onChange={onAutoApplyEnabledChange}>
                  Apply the detected key automatically
                </Check>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={autoApplyConfidencePct}
                    onChange={(e) => onAutoApplyConfidencePctChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    className="gear-fader min-w-0 flex-1 cursor-pointer"
                    aria-label="Auto apply confidence threshold"
                  />
                  <span className="tele w-11 shrink-0 text-right font-mono text-[11px] text-gear-text/85">
                    {autoApplyConfidencePct}%
                  </span>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-gear-engrave">
                  Fires once per key change, at or above the threshold.
                </p>
              </Section>

              <Section title="Suggest key for review">
                <div className="flex flex-wrap items-center gap-2">
                  <GearSelect
                    value={suggestKey}
                    onChange={(e) => setSuggestKey(e.target.value)}
                    aria-label="Suggestion key"
                    className="w-20"
                  >
                    {SUGGEST_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </GearSelect>
                  <GearSelect
                    value={suggestMode}
                    onChange={(e) => setSuggestMode(e.target.value as 'major' | 'minor')}
                    aria-label="Suggestion mode"
                    className="w-24"
                  >
                    <option value="major">major</option>
                    <option value="minor">minor</option>
                  </GearSelect>
                  <GearButton
                    onClick={() => {
                      void cloudResolution.submitSuggestion(suggestKey, suggestMode);
                    }}
                    disabled={!mediaSession.title || !mediaSession.artist || cloudResolution.suggestionStatus === 'submitting'}
                  >
                    {cloudResolution.suggestionStatus === 'submitting' ? 'Sending' : 'Submit'}
                  </GearButton>
                </div>
                {cloudResolution.suggestionMessage ? (
                  <p className="mt-2 text-[11px] text-gear-text/75">{cloudResolution.suggestionMessage}</p>
                ) : null}
              </Section>

              {import.meta.env.DEV ? (
                <Section title="Cloud test bench">
                  <Check checked={devMockEnabled} onChange={onDevMockEnabledChange}>
                    Use a mock track for cloud lookup
                  </Check>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <GearInput value={devMockTitle} onChange={(e) => onDevMockTitleChange(e.target.value)} placeholder="Title" />
                    <GearInput value={devMockArtist} onChange={(e) => onDevMockArtistChange(e.target.value)} placeholder="Artist" />
                  </div>

                  <div className="mt-3 space-y-2">
                    <GearInput value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="API base override" />
                    <div className="flex gap-1.5">
                      <GearButton
                        onClick={() => {
                          setSongKeyApiBaseForDev(apiBase);
                          setApiBase(getSongKeyApiBaseForDev());
                        }}
                      >
                        Apply base
                      </GearButton>
                      <GearButton
                        onClick={() => {
                          setSongKeyApiBaseForDev(null);
                          setApiBase(getSongKeyApiBaseForDev());
                        }}
                      >
                        Reset base
                      </GearButton>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="flex gap-1.5">
                      <GearInput
                        value={freqblogKey}
                        onChange={(e) => setFreqblogKey(e.target.value)}
                        placeholder="FreqBlog API key"
                        className="min-w-0"
                      />
                      <GearButton
                        className="shrink-0"
                        onClick={() => {
                          setFreqblogApiKeyForDev(freqblogKey);
                          setFreqblogKey(getFreqblogApiKeyForDev());
                        }}
                      >
                        Save
                      </GearButton>
                    </div>
                    <div className="flex gap-1.5">
                      <GearInput
                        value={getSongBpmKey}
                        onChange={(e) => setGetSongBpmKey(e.target.value)}
                        placeholder="GetSongBPM API key"
                        className="min-w-0"
                      />
                      <GearButton
                        className="shrink-0"
                        onClick={() => {
                          setGetSongBpmApiKeyForDev(getSongBpmKey);
                          setGetSongBpmKey(getGetSongBpmApiKeyForDev());
                        }}
                      >
                        Save
                      </GearButton>
                    </div>
                  </div>

                  <Row label="Track identity" value={cloudResolution.trackIdentity ?? '<none>'} />
                  {cloudResolution.cloudHit?.source === 'getsongbpm' ? (
                    <p className="mt-1.5 text-[10px] text-gear-engrave">
                      Key data from{' '}
                      <a className="underline decoration-gear-engrave" href="https://getsongbpm.com" target="_blank" rel="noreferrer">
                        GetSongBPM.com
                      </a>
                    </p>
                  ) : null}
                </Section>
              ) : null}
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
