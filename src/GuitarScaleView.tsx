import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Layers3, Radio, SlidersHorizontal, Waves } from 'lucide-react';
import type { ScaleContext, ScaleType } from './scaleDataProvider';
import { ChordLibrarySection } from './ChordLibrarySection';
import type { ScaleChordWithVoicings } from './chords/chordTypes';
import { buildScaleNotes, pitchClassForNoteLabel } from './scaleSpell';
import { TUNING_PRESETS } from './tunings';
import { useMediaSession } from './hooks/useMediaSession';
import { useDetectedKey, type DetectedKeyState } from './hooks/useDetectedKey';
import { useCloudKeyResolution } from './hooks/useCloudKeyResolution';
import { autoApplyConfidencePct as computeApplyConfidencePct } from './services/applyConfidence';
import { resolveShownKey } from './services/resolveShownKey';
import { trace } from './services/debugLog';
import { Fretboard } from './fretboard/Fretboard';
import type { FretboardViewMode } from './fretboard/geometry';
import { Led } from './ui/gear';
import { deckStatusLabel, detectionLed, keySourceLabel } from './ui/statusLabels';
import { KeyReadout } from './ui/KeyReadout';
import { SourceStrip } from './ui/SourceStrip';
import { ScaleControls } from './ui/ScaleControls';
import { ViewModeSwitch } from './ui/ViewModeSwitch';
import { DevDrawer } from './ui/DevDrawer';
import './ui/lab-jam.css';

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
 * The chassis, wearing the Live Jam dress. The layout language is Jam's — an editorial heading, a
 * deck row, toggle cards, one framed bay — but the materials, the controls and the neck itself are
 * the Lab's, and the neck still gets the entire width of the window.
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
  /* Chrome state: what the setup row, the chord bank and the focus switch are doing. */
  const [setupOpen, setSetupOpen] = useState(true);
  const [bankOpen, setBankOpen] = useState(true);
  const [focus, setFocus] = useState(false);
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
  /* See services/resolveShownKey: an unverified catalog key does not outrank a confident local one. */
  const shownKey = useMemo(
    () => resolveShownKey({ cloudHit: cloudResolution.cloudHit, detected: effectiveDetectedKey }),
    [cloudResolution.cloudHit, effectiveDetectedKey],
  );
  const activePrimaryKey = shownKey.key;
  const activePrimaryScale = shownKey.scale;
  const activeDisplayName = shownKey.displayName;
  /* Only the hit that actually reached the screen may label or price the shown key. */
  const shownCloudHit = shownKey.source === 'verified' || shownKey.source === 'catalog'
    ? cloudResolution.cloudHit
    : null;

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
        cloudHit: shownCloudHit,
        detected: effectiveDetectedKey,
      }),
    [shownCloudHit, effectiveDetectedKey],
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

  const desktop = mediaSession.playbackStatus !== 'media_session_unavailable';
  const playing = mediaSession.playbackStatus === 'playing';
  const det = detectionLed(effectiveDetectedKey.state);
  const status = deckStatusLabel({
    playbackStatus: mediaSession.playbackStatus,
    detectionState: effectiveDetectedKey.state,
    resolutionState: cloudResolution.resolutionState,
    hasCloudHit: !!shownCloudHit,
    showingProposedKey,
    locked: lockDetected,
  });

  return (
    <div className={`lab-screen ${focus ? 'lab-focused' : ''}`}>
      <header className="lab-heading">
        <div>
          <span className="lab-kicker">
            <span className="lab-index">01</span>
            <span>Fretboard Lab</span>
            <span>· One key, the whole neck.</span>
          </span>
          <h1>
            Every note, <em>in its place.</em>
          </h1>
        </div>
        <div className="lab-heading-actions">
          <span className={`lab-status ${playing ? 'on' : ''}`}>
            <Led tone={det.tone} pulse={det.pulse} />
            {status}
          </span>
          <button
            type="button"
            className="lab-eng"
            onClick={() => setDevOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={devOpen}
            title="Diagnostics and lab switches"
          >
            <Led tone={devOpen ? 'data' : 'off'} size={5} />
            Eng
          </button>
        </div>
      </header>

      {/* Deck: the record, what the machine hears, and the key now on the neck. */}
      <div className="lab-deck">
        <div className={`lab-record ${playing ? 'spinning' : ''}`} aria-hidden="true">
          <div className="lab-record-orbit" />
          <div className="lab-vinyl">
            <div className="lab-vinyl-label">
              <Waves size={30} />
              <span>
                FRETBOARD
                <br />
                LAB
              </span>
              <i />
            </div>
          </div>
          <span className="lab-record-caption">Six strings. Twenty-four frets.</span>
        </div>

        <SourceStrip
          mediaSession={mediaSession}
          detected={effectiveDetectedKey}
          resolutionState={cloudResolution.resolutionState}
          hasCloudHit={!!shownCloudHit}
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

        <KeyReadout
          root={scale.root}
          scaleType={scaleType}
          notes={notes}
          sourceLabel={keySourceLabel({
            resolutionState: cloudResolution.resolutionState,
            hasCloudHit: !!shownCloudHit,
            showingProposedKey,
          })}
        />
      </div>

      <div className="lab-control-strip">
        <button
          type="button"
          className={`lab-control ${autoApplyEnabled ? 'selected' : ''}`}
          aria-pressed={autoApplyEnabled}
          disabled={!desktop}
          onClick={() => setAutoApplyEnabled(!autoApplyEnabled)}
        >
          <Radio size={19} />
          <span>
            <strong>Follow the song</strong>
            <small>
              {!desktop
                ? 'Needs the desktop app'
                : autoApplyEnabled
                  ? `Applies on its own from ${autoApplyConfidencePct}%`
                  : 'Apply detected keys by hand'}
            </small>
          </span>
          <i className="lab-switch" />
        </button>
        <button
          type="button"
          className={`lab-control ${bankOpen ? 'selected' : ''}`}
          aria-pressed={bankOpen}
          aria-controls="lab-chord-bank"
          onClick={() => {
            setBankOpen(!bankOpen);
            setSelectedChord(null);
          }}
        >
          <Layers3 size={19} />
          <span>
            <strong>Chord bank</strong>
            <small>Shapes that live in this key</small>
          </span>
          <i className="lab-switch" />
        </button>
        <button
          type="button"
          className={`lab-control ${focus ? 'selected' : ''}`}
          aria-pressed={focus}
          onClick={() => setFocus(!focus)}
        >
          <Waves size={19} />
          <span>
            <strong>Neck focus</strong>
            <small>Clear the deck off the bench</small>
          </span>
          <i className="lab-switch" />
        </button>
      </div>

      {!desktop && (
        <p className="lab-notice">
          Listening runs in the desktop app: it reads the OS media session and analyses what is playing.
          Everything else — root, scale, tuning, capo and the chord bank — works here.
        </p>
      )}

      {/* Neck bay: the one place on the chassis with nothing competing for attention. */}
      <div className="lab-map">
        <div className="lab-map-heading">
          <div>
            <span className="lab-module-label">The whole neck, connected</span>
            <h2>
              {title}
              <span>
                {numFrets} frets · {tuning.label}
              </span>
            </h2>
          </div>
          <div className="lab-map-actions">
            <ViewModeSwitch value={viewMode} onChange={setViewMode} />
            <button
              type="button"
              className={`lab-icon-button ${setupOpen ? 'is-active' : ''}`}
              aria-label="Root, scale, tuning and capo"
              aria-expanded={setupOpen}
              aria-controls="lab-setup"
              onClick={() => setSetupOpen(!setupOpen)}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {setupOpen && (
            <motion.div
              id="lab-setup"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
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
            </motion.div>
          )}
        </AnimatePresence>

        <div className="lab-neck">
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

        <div className="lab-map-footer">
          <div className="lab-legend">
            <span>
              <i className="dot-root" />
              Root / home
            </span>
            <span>
              <i className="dot-scale" />
              {selectedChord ? `${selectedChord.chordName} chord tones` : 'Scale tones'}
            </span>
          </div>
          <span>
            {capo ? `Capo ${capo} · frets counted from the nut · ` : ''}Amber rings mark the root, everywhere
            it falls
          </span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {bankOpen && (
          <motion.section
            id="lab-chord-bank"
            className="lab-bank"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="lab-bank-heading">
              <div>
                <span className="lab-module-label">A palette to play with</span>
                <h2>Chords that live in this key.</h2>
                <p>One module per degree of the scale, with every shape that fits your tuning and capo.</p>
              </div>
              <Layers3 size={27} />
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
          </motion.section>
        )}
      </AnimatePresence>

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
