import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScaleContext, ScaleType } from './scaleDataProvider';
import { ChordLibrarySection } from './ChordLibrarySection';
import type { ScaleChordWithVoicings } from './chords/chordTypes';
import { buildScaleNotes, pitchClassForNoteLabel } from './scaleSpell';
import { TUNING_PRESETS } from './tunings';
import { useMediaSession } from './hooks/useMediaSession';
import { useDetectedKey, type DetectedKeyState } from './hooks/useDetectedKey';
import { useCloudKeyResolution } from './hooks/useCloudKeyResolution';
import { autoApplyConfidencePct as computeApplyConfidencePct } from './services/applyConfidence';
import { trace } from './services/debugLog';
import { Fretboard } from './fretboard/Fretboard';
import type { FretboardViewMode } from './fretboard/geometry';
import { Led, Panel, Screw, Seam } from './ui/gear';
import { keySourceLabel } from './ui/statusLabels';
import { KeyReadout } from './ui/KeyReadout';
import { SourceStrip } from './ui/SourceStrip';
import { ScaleControls } from './ui/ScaleControls';
import { ViewModeSwitch } from './ui/ViewModeSwitch';
import { DevDrawer } from './ui/DevDrawer';

/** Open + 24 fretted positions (extend via props later). */
const DEFAULT_NUM_FRETS = 24;

type Props = {
  scale: ScaleContext;
  rootInput: string;
  onRootInputChange: (value: string) => void;
  rootInvalid: boolean;
  scaleType: ScaleType;
  onScaleTypeChange: (value: ScaleType) => void;
  /** Restore root + scale from the brain / engine defaults (see scaleDataProvider). */
  onResetToBrainKey: () => void;
  onApplyDetectedKey: (root: string, scale: 'major' | 'minor') => void;
  /** Swap the shown key for its relative major/minor. */
  onFlipRelative: () => void;
  numFrets?: number;
};

/**
 * The chassis. Owns app state and lays out three bays: the control face, the neck, and the chord
 * bank. Rendering the neck itself belongs to `Fretboard`; diagnostics belong to `DevDrawer`.
 */
export default function GuitarScaleView({
  scale,
  rootInput,
  onRootInputChange,
  rootInvalid,
  scaleType,
  onScaleTypeChange,
  onResetToBrainKey,
  onApplyDetectedKey,
  onFlipRelative,
  numFrets = DEFAULT_NUM_FRETS,
}: Props) {
  const [viewMode, setViewMode] = useState<FretboardViewMode>('scale-all');
  const [tuningId, setTuningId] = useState<string>('standard');
  const [capoFret, setCapoFret] = useState<number>(0);
  const [selectedChord, setSelectedChord] = useState<ScaleChordWithVoicings | null>(null);
  const [lockDetected, setLockDetected] = useState(false);
  const [lockedDetectedSnapshot, setLockedDetectedSnapshot] = useState<DetectedKeyState | null>(null);
  const [autoApplyEnabled, setAutoApplyEnabled] = useState(false);
  const [autoApplyConfidencePct, setAutoApplyConfidencePct] = useState(85);
  const [devMockEnabled, setDevMockEnabled] = useState(false);
  const [devMockTitle, setDevMockTitle] = useState('Numb');
  const [devMockArtist, setDevMockArtist] = useState('Linkin Park');
  const [devOpen, setDevOpen] = useState(false);
  const lastAutoAppliedSignatureRef = useRef<string | null>(null);
  const lastAutoDecisionRef = useRef<string>('');

  const mediaSession = useMediaSession();
  const { detectedKey, detectedKeyAb, resetDetection } = useDetectedKey();
  const cloudMediaInput = useMemo(
    () =>
      devMockEnabled
        ? {
            ...mediaSession,
            title: devMockTitle.trim() || mediaSession.title,
            artist: devMockArtist.trim() || mediaSession.artist,
            playbackStatus: 'playing',
          }
        : mediaSession,
    [devMockArtist, devMockEnabled, devMockTitle, mediaSession],
  );
  const cloudResolution = useCloudKeyResolution(cloudMediaInput, detectedKey);
  const effectiveDetectedKey = lockDetected && lockedDetectedSnapshot ? lockedDetectedSnapshot : detectedKey;
  const activePrimaryKey = cloudResolution.cloudHit?.key ?? effectiveDetectedKey.primaryKey;
  const activePrimaryScale = cloudResolution.cloudHit?.mode ?? effectiveDetectedKey.primaryScale;
  const activeDisplayName = cloudResolution.cloudHit?.displayName ?? effectiveDetectedKey.displayName;

  useEffect(() => {
    setSelectedChord(null);
  }, [scale.root, scale.scaleType]);

  const tuning = useMemo(() => {
    return TUNING_PRESETS.find((t) => t.id === tuningId) ?? TUNING_PRESETS[0]!;
  }, [tuningId]);
  const capo = Math.max(0, Math.min(12, capoFret));

  const notes = useMemo(() => buildScaleNotes(scale.root, scale.scaleType), [scale.root, scale.scaleType]);
  const title = scale.title || `${scale.root} ${scale.scaleType}`;

  /* Compared by pitch class so an enharmonic spelling (G# vs Ab) still counts as the same key. */
  const showingProposedKey = useMemo(() => {
    if (!activePrimaryKey || (activePrimaryScale !== 'major' && activePrimaryScale !== 'minor')) {
      return false;
    }
    if (scaleType !== activePrimaryScale) {
      return false;
    }
    const shown = pitchClassForNoteLabel(scale.root);
    const proposed = pitchClassForNoteLabel(activePrimaryKey);
    return shown !== null && shown === proposed;
  }, [activePrimaryKey, activePrimaryScale, scale.root, scaleType]);

  const handleRestoreDefault = () => {
    onResetToBrainKey();
    setTuningId('standard');
    setCapoFret(0);
    setSelectedChord(null);
  };

  const hasDetectedApplyCandidate =
    !!activePrimaryKey && (activePrimaryScale === 'major' || activePrimaryScale === 'minor');
  const canApplyDetected = hasDetectedApplyCandidate;

  /* See services/applyConfidence: what the shown key is worth depends on where it came from. */
  const autoApplyConfidencePctNow = useMemo(
    () =>
      computeApplyConfidencePct({
        cloudHit: cloudResolution.cloudHit,
        detected: effectiveDetectedKey,
      }),
    [cloudResolution.cloudHit, effectiveDetectedKey],
  );

  const handleApplyDetected = () => {
    if (!hasDetectedApplyCandidate || !activePrimaryKey || !activePrimaryScale) {
      return;
    }
    if (activePrimaryScale !== 'major' && activePrimaryScale !== 'minor') {
      return;
    }
    trace('apply', 'manual', `User applied ${activePrimaryKey} ${activePrimaryScale} to the fretboard`, {
      key: activePrimaryKey,
      scale: activePrimaryScale,
      source: cloudResolution.source,
    }, 'ok');
    onApplyDetectedKey(activePrimaryKey, activePrimaryScale);
  };

  const toggleLockDetected = () => {
    if (lockDetected) {
      trace('apply', 'unlock', 'Unlocked the detected-key snapshot', undefined, 'decide');
      setLockDetected(false);
      setLockedDetectedSnapshot(null);
      return;
    }
    trace('apply', 'lock', `Locked the detected-key snapshot at ${detectedKey.displayName ?? 'none'}`, {
      key: detectedKey.primaryKey,
      scale: detectedKey.primaryScale,
    }, 'decide');
    setLockedDetectedSnapshot(detectedKey);
    setLockDetected(true);
  };

  useEffect(() => {
    const logDecision = (event: string, message: string, detail: Record<string, unknown>) => {
      const sig = `${event}|${message}|${detail.key ?? ''}|${detail.confidence ?? ''}|${detail.threshold ?? ''}`;
      if (lastAutoDecisionRef.current === sig) {
        return;
      }
      lastAutoDecisionRef.current = sig;
      trace('apply', event, message, detail, event === 'auto.apply' ? 'ok' : 'skip');
    };

    if (!autoApplyEnabled || !hasDetectedApplyCandidate) {
      if (!autoApplyEnabled) {
        lastAutoAppliedSignatureRef.current = null;
      }
      return;
    }
    const detectedScale = activePrimaryScale;
    if ((detectedScale !== 'major' && detectedScale !== 'minor') || !activePrimaryKey) {
      return;
    }
    if (autoApplyConfidencePctNow < autoApplyConfidencePct) {
      logDecision(
        'auto.skip',
        `Auto-apply skipped: shown key is worth ${autoApplyConfidencePctNow}% but the threshold is ${autoApplyConfidencePct}%`,
        {
          key: activePrimaryKey,
          scale: detectedScale,
          confidence: autoApplyConfidencePctNow,
          threshold: autoApplyConfidencePct,
          source: cloudResolution.source,
          why: 'below_threshold',
        },
      );
      return;
    }
    const signature = `${activePrimaryKey}:${detectedScale}`;
    if (lastAutoAppliedSignatureRef.current === signature) {
      return;
    }
    logDecision('auto.apply', `Auto-applying ${activePrimaryKey} ${detectedScale} to the fretboard`, {
      key: activePrimaryKey,
      scale: detectedScale,
      confidence: autoApplyConfidencePctNow,
      threshold: autoApplyConfidencePct,
      source: cloudResolution.source,
      why: 'threshold_met',
    });
    onApplyDetectedKey(activePrimaryKey, detectedScale);
    lastAutoAppliedSignatureRef.current = signature;
  }, [
    activePrimaryKey,
    activePrimaryScale,
    autoApplyEnabled,
    autoApplyConfidencePct,
    autoApplyConfidencePctNow,
    cloudResolution.source,
    hasDetectedApplyCandidate,
    onApplyDetectedKey,
  ]);

  return (
    <div className="relative flex min-h-[100dvh] flex-1 flex-col bg-gear-void">
      {/* Rack strip: brand plate, power lamp, engineering latch. */}
      <header className="gear-brushed relative z-10 flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <Screw className="left-2 top-1/2 -translate-y-1/2" />
        <Screw className="right-2 top-1/2 -translate-y-1/2" />
        <div className="flex min-w-0 items-center gap-2.5 pl-4">
          <Led tone="live" size={6} label="Power" />
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.28em] text-gear-legend">
            Fretboard Lab
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDevOpen(true)}
          className="legend mr-5 flex shrink-0 items-center gap-1.5 rounded-[3px] bg-[linear-gradient(180deg,#2a2a31_0%,#212127_48%,#171a1c_100%)] px-2.5 py-[5px] shadow-raised transition-[filter,transform] hover:brightness-125 active:translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gear-accent/70"
          aria-haspopup="dialog"
          aria-expanded={devOpen}
          title="Diagnostics and lab switches"
        >
          <Led tone={devOpen ? 'data' : 'off'} size={5} />
          Eng
        </button>
      </header>
      <Seam />

      {/* Control face. */}
      <div className="shrink-0 px-3 pt-3 sm:px-5 lg:px-8">
        <Panel className="p-3 sm:p-4">
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
            <KeyReadout
              root={scale.root}
              scaleType={scaleType}
              notes={notes}
              sourceLabel={keySourceLabel({
                resolutionState: cloudResolution.resolutionState,
                hasCloudHit: !!cloudResolution.cloudHit,
                showingProposedKey,
              })}
            />
            <SourceStrip
              mediaSession={mediaSession}
              detected={effectiveDetectedKey}
              resolutionState={cloudResolution.resolutionState}
              hasCloudHit={!!cloudResolution.cloudHit}
              proposedKeyName={activeDisplayName}
              confidence={effectiveDetectedKey.confidence}
              canApply={canApplyDetected}
              onApply={handleApplyDetected}
              locked={lockDetected}
              onToggleLock={toggleLockDetected}
              onResetDetection={() => {
                void resetDetection();
              }}
            />
          </div>

          <Seam className="my-3.5" />

          <ScaleControls
            rootInput={rootInput}
            onRootInputChange={onRootInputChange}
            rootInvalid={rootInvalid}
            scaleType={scaleType}
            onScaleTypeChange={onScaleTypeChange}
            tuningId={tuningId}
            onTuningChange={setTuningId}
            capo={capo}
            onCapoChange={setCapoFret}
            onRestoreDefault={handleRestoreDefault}
            onFlipRelative={onFlipRelative}
          />
        </Panel>
      </div>

      {/* Neck bay: the one place on the chassis with nothing competing for attention. */}
      <div className="flex min-h-0 w-full flex-1 flex-col justify-center px-3 pt-5 sm:px-5 lg:px-8">
        {/* Cancel only the right padding so the neck can touch the screen edge without rescaling. */}
        <div className="-mr-3 flex min-h-[14rem] flex-1 items-center sm:-mr-5 lg:-mr-8">
          <Fretboard
            root={scale.root}
            scaleType={scaleType}
            notes={notes}
            viewMode={viewMode}
            openStringPcs={tuning.openStringPcs}
            stringLabels={tuning.stringLabels}
            capo={capo}
            numFrets={numFrets}
            selectedChord={selectedChord}
            title={title}
          />
        </div>
      </div>

      {/* Display bank, directly under the thing it drives. */}
      <div className="shrink-0 px-3 pt-4 sm:px-5 lg:px-8">
        <Panel className="px-3 py-2.5 sm:px-4">
          <ViewModeSwitch value={viewMode} onChange={setViewMode} />
        </Panel>
      </div>

      <ChordLibrarySection
        root={scale.root}
        scaleType={scaleType}
        tuningId={tuningId}
        openStringPcs={tuning.openStringPcs}
        tuningLabel={tuning.label}
        stringLabels={tuning.stringLabels}
        capo={capo}
        selectedChord={selectedChord}
        onChordSelect={setSelectedChord}
      />

      <DevDrawer
        open={devOpen}
        onClose={() => setDevOpen(false)}
        mediaSession={mediaSession}
        detected={effectiveDetectedKey}
        detectedKeyAb={detectedKeyAb}
        cloudResolution={cloudResolution}
        activeDisplayName={activeDisplayName}
        canApply={canApplyDetected}
        autoApplyEnabled={autoApplyEnabled}
        onAutoApplyEnabledChange={setAutoApplyEnabled}
        autoApplyConfidencePct={autoApplyConfidencePct}
        onAutoApplyConfidencePctChange={setAutoApplyConfidencePct}
        devMockEnabled={devMockEnabled}
        onDevMockEnabledChange={setDevMockEnabled}
        devMockTitle={devMockTitle}
        onDevMockTitleChange={setDevMockTitle}
        devMockArtist={devMockArtist}
        onDevMockArtistChange={setDevMockArtist}
      />
    </div>
  );
}
