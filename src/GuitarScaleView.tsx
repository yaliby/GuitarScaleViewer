import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Layers3, Menu, SlidersHorizontal, X } from 'lucide-react';
import type { ScaleContext, ScaleType } from './scaleDataProvider';
import { ChordLibrarySection } from './ChordLibrarySection';
import type { ScaleChordWithVoicings } from './chords/chordTypes';
import { buildScaleNotes, pitchClassForNoteLabel } from './scaleSpell';
import { TUNING_PRESETS } from './tunings';
import { useMediaSession } from './hooks/useMediaSession';
import { controlMediaPlayback, seekMedia } from './hooks/mediaTransport';
import { useDetectedKey } from './hooks/useDetectedKey';
import { useCloudKeyResolution } from './hooks/useCloudKeyResolution';
import { clearsApplyGate, fuseKey, shouldRevise } from './services/keyFusion';
import { readNeckFollow, useNeckFollow } from './neckFollow';
import { trace } from './services/debugLog';
import { Fretboard } from './fretboard/Fretboard';
import type { FretboardViewMode } from './fretboard/geometry';
import { Led } from './ui/gear';
import { keySourceLabel } from './ui/statusLabels';
import { KeyReadout } from './ui/KeyReadout';
import { SourceStrip } from './ui/SourceStrip';
import { VinylDeck } from './ui/VinylDeck';
import { ScaleControls } from './ui/ScaleControls';
import { ViewModeSwitch } from './ui/ViewModeSwitch';
import { DevDrawer } from './ui/DevDrawer';
import { useTrackCapture } from './hooks/useTrackCapture';
import { rememberScale } from './services/songMemory';
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
  tuningId: string;
  onTuningChange: (value: string) => void;
  capo: number;
  onCapoChange: (value: number) => void;
  /** 0–100: how sure the pipeline must be before Apply moves the neck. Session-wide. */
  applyThreshold: number;
  onApplyThresholdChange: (thresholdPct: number) => void;
  /** Restore root + scale from the brain / engine defaults (see scaleDataProvider). */
  onResetToBrainKey: () => void;
  onApplyDetectedKey: (root: string, scale: 'major' | 'minor') => void;
  /** Swap the shown key for its relative major/minor. */
  onFlipRelative: () => void;
  /** The shell's navigation drawer. This screen is the whole window, so it carries the toggle. */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /**
   * False while this screen is kept alive on another workspace. Detection still runs;
   * only the visible screen is allowed to move the neck or talk to the engine.
   */
  followSong?: boolean;
  numFrets?: number;
};

/**
 * Live Jam itself: an editorial heading, a listening deck, toggle cards and one framed bay for the
 * neck, built in the Lab's own materials. It fills the window — the Studio navigation folds into
 * the hamburger for this screen — and the key, tuning and capo it works on are the session's, so
 * whatever the song turns out to be in is what the other screens practice.
 */
export default function GuitarScaleView({
  scale,
  rootInput,
  onRootInputChange,
  rootInvalid,
  scaleType,
  onScaleTypeChange,
  tuningId,
  onTuningChange,
  capo: capoFret,
  onCapoChange,
  applyThreshold,
  onApplyThresholdChange,
  onResetToBrainKey,
  onApplyDetectedKey,
  onFlipRelative,
  menuOpen,
  onToggleMenu,
  followSong = true,
  numFrets = DEFAULT_NUM_FRETS,
}: Props) {
  const [viewMode, setViewMode] = useState<FretboardViewMode>('scale-all');
  const [selectedChord, setSelectedChord] = useState<ScaleChordWithVoicings | null>(null);
  /* Apply and the settled key live outside this screen, so leaving the room does not
     turn follow back on or throw away the reading the neck was holding. */
  const { applyDetected, setApplyDetected, neckKey, setNeckKey } = useNeckFollow();
  const [devMockEnabled, setDevMockEnabled] = useState(false);
  const [devMockTitle, setDevMockTitle] = useState('Numb');
  const [devMockArtist, setDevMockArtist] = useState('Linkin Park');
  const [devOpen, setDevOpen] = useState(false);
  /* Chrome state: whether the setup row is open. The chord bank is always on now. */
  const [setupOpen, setSetupOpen] = useState(true);
  /* Vinyl cue: the progress bar follows the platter instantly, then yields to the OS clock. */
  const [cuePositionMs, setCuePositionMs] = useState<number | null>(null);
  /* Play/pause on the record is optimistic: the grooves stop or start before the OS session catches up. */
  const [heldPlaybackStatus, setHeldPlaybackStatus] = useState<string | null>(null);
  const follow = readNeckFollow();

  const mediaSession = useMediaSession();
  const capture = useTrackCapture(mediaSession);
  const { detectedKey, detectedKeyAb } = useDetectedKey();
  const cloudMediaInput = useMemo(
    () =>
      followSong && devMockEnabled
        ? {
            ...mediaSession,
            title: devMockTitle.trim() || mediaSession.title,
            artist: devMockArtist.trim() || mediaSession.artist,
            playbackStatus: 'playing',
          }
        : mediaSession,
    [devMockArtist, devMockEnabled, devMockTitle, followSong, mediaSession],
  );
  const cloudResolution = useCloudKeyResolution(cloudMediaInput, detectedKey, followSong);

  /* Library lookup is the bundled dictionary. A miss leaves the local engine as the remaining leg. */
  const cloudHit = cloudResolution.cloudHit;
  const verifiedCandidate = useMemo(
    () => (cloudHit?.verified ? { key: cloudHit.key, mode: cloudHit.mode, displayName: cloudHit.displayName } : null),
    [cloudHit],
  );

  /* See services/keyFusion. There is always an answer here — the only question is how sure. */
  const fused = useMemo(
    () =>
      fuseKey({
        verified: verifiedCandidate,
        detected: detectedKey,
        held: neckKey,
        trackIdentity: cloudResolution.trackIdentity,
      }),
    [verifiedCandidate, detectedKey, neckKey, cloudResolution.trackIdentity],
  );
  const activeDisplayName = fused.displayName;
  const shownCloudHit = fused.source === 'verified' ? cloudHit : null;

  useEffect(() => {
    setSelectedChord(null);
  }, [scale.root, scale.scaleType]);

  const tuning = useMemo(() => {
    return TUNING_PRESETS.find((t) => t.id === tuningId) ?? TUNING_PRESETS[0]!;
  }, [tuningId]);
  const capo = Math.max(0, Math.min(12, capoFret));

  const notes = useMemo(() => buildScaleNotes(scale.root, scale.scaleType), [scale.root, scale.scaleType]);
  const title = scale.title || `${scale.root} ${scale.scaleType}`;

  /* Is the neck drawing the key the pipeline settled on? Compared by pitch class, so an
     enharmonic spelling (G# vs Ab) still counts as the same key. False means the player
     overrode it by hand in the setup row, and the readout says "Manual". */
  const showingProposedKey = useMemo(() => {
    if (!fused.root || !fused.scale || scaleType !== fused.scale) {
      return false;
    }
    const shown = pitchClassForNoteLabel(scale.root);
    const proposed = pitchClassForNoteLabel(fused.root);
    return shown !== null && shown === proposed;
  }, [fused.root, fused.scale, scale.root, scaleType]);

  const handleRestoreDefault = () => {
    onResetToBrainKey();
    onTuningChange('standard');
    onCapoChange(0);
    setSelectedChord(null);
  };

  const toggleApplyDetected = () => {
    const next = !applyDetected;
    const drawn = `${scale.root} ${scaleType}`;
    trace(
      'apply',
      next ? 'apply.on' : 'apply.off',
      next
        ? `Apply on: the neck follows the song again (${fused.displayName ?? 'waiting for a key'})`
        : `Apply off: the neck stays at ${drawn} — the song no longer moves it`,
      {
        drawnRoot: scale.root,
        drawnScale: scaleType,
        fusedKey: fused.root,
        fusedScale: fused.scale,
        certainty: fused.certainty,
      },
      'decide',
    );
    setApplyDetected(next);
  };

  /**
   * Picking a key by hand *is* the decision to stop following the song, so it drops Apply on the
   * spot. Without that the player sets G, the pipeline's next revision takes the neck back, and
   * the edit looks like it was ignored — the one thing a manual control must never do.
   */
  const dropApplyForHandEdit = (what: string) => {
    if (!applyDetected) {
      return;
    }
    trace(
      'apply',
      'apply.off',
      `Apply off: ${what} by hand — the neck stays where the player put it`,
      {
        drawnRoot: scale.root,
        drawnScale: scaleType,
        fusedKey: fused.root,
        fusedScale: fused.scale,
        why: 'hand_edit',
      },
      'decide',
    );
    setApplyDetected(false);
  };

  /**
   * The neck follows the song. Apply is on and the gate ships open, so the best currently
   * available answer is the one drawn, and a better one replaces it as soon as it clears the
   * revision margin (see services/keyFusion).
   *
   * Switching Apply back on is the exception to the margin: "follow the song again" means put
   * the pipeline's current answer on the board even if a leftover key (or a hand edit) is still
   * sitting there. Without that, the deck can read A minor while the neck stays on G — the
   * Stairway case.
   *
   * It is *not* an exception to the gate. A player who set the gate to 70 asked for one thing —
   * nothing under 70 on the neck — and a toggle they pressed for an unrelated reason must not
   * quietly walk a 35% reading past it. Under the gate the neck simply keeps what it has and
   * the deck says why.
   *
   * So the re-enable is owed rather than spent: it waits in `applyPendingRef` until a reading
   * clears the gate, and is honoured then. Dropping it at the gate would put the Stairway case
   * straight back — Apply comes back on under a gate, the reading climbs through a minute later
   * with nothing to beat on the revision margin, and the neck sits on a stale key for the rest
   * of the song while the deck reads the right one.
   */
  useEffect(() => {
    if (!followSong) return;
    if (!follow.prevApply && applyDetected) {
      follow.applyPending = true;
    }
    follow.prevApply = applyDetected;
    if (!applyDetected) {
      follow.applyPending = false;
      return;
    }
    if (!fused.root || !fused.scale) {
      return;
    }
    if (!clearsApplyGate(fused, applyThreshold)) {
      const held = `${fused.root}:${fused.scale}:${fused.confidencePct}:${applyThreshold}`;
      if (follow.lastGateHold !== held) {
        follow.lastGateHold = held;
        trace(
          'apply',
          'apply.gate',
          `Held under the Apply gate: ${fused.displayName} is ${fused.confidencePct}%, the gate is ${applyThreshold}%`,
          {
            key: fused.root,
            scale: fused.scale,
            certainty: fused.certainty,
            confidence: fused.confidencePct,
            gate: applyThreshold,
            why: 'under_apply_gate',
          },
          'skip',
        );
      }
      return;
    }
    follow.lastGateHold = '';
    const justEnabled = follow.applyPending;
    follow.applyPending = false;
    if (!justEnabled && !shouldRevise(neckKey, fused)) {
      return;
    }
    const sig = `${fused.root}:${fused.scale}:${fused.certainty}`;
    if (follow.lastAutoDecision !== sig || justEnabled) {
      follow.lastAutoDecision = sig;
      trace(
        'apply',
        'neck.follow',
        justEnabled
          ? `Neck follows the song after Apply came back on: ${fused.displayName} (${fused.certainty}, ${fused.confidencePct}%)`
          : `Neck follows the song: ${fused.displayName} (${fused.certainty}, ${fused.confidencePct}%)`,
        {
          key: fused.root,
          scale: fused.scale,
          certainty: fused.certainty,
          confidence: fused.confidencePct,
          noteSetP: fused.noteSetP,
          notesSettled: fused.notesSettled,
          from: neckKey?.displayName ?? null,
          why: justEnabled ? 'apply_reenabled' : fused.why,
        },
        'ok',
      );
    }
    setNeckKey(fused);
    onApplyDetectedKey(fused.root, fused.scale);
  }, [applyDetected, applyThreshold, followSong, fused, neckKey, onApplyDetectedKey]);

  useEffect(() => {
    if (heldPlaybackStatus == null) {
      return;
    }
    if (mediaSession.playbackStatus === heldPlaybackStatus) {
      setHeldPlaybackStatus(null);
      return;
    }
    const id = window.setTimeout(() => setHeldPlaybackStatus(null), 5_000);
    return () => window.clearTimeout(id);
  }, [heldPlaybackStatus, mediaSession.playbackStatus]);

  const desktop = mediaSession.playbackStatus !== 'media_session_unavailable';
  const deckSession =
    heldPlaybackStatus == null
      ? mediaSession
      : { ...mediaSession, playbackStatus: heldPlaybackStatus };
  const playing = deckSession.playbackStatus === 'playing';
  const vinylInteractive =
    desktop && !['none', 'closed', 'media_session_unavailable'].includes(mediaSession.playbackStatus);
  return (
    <div className="lab-screen">
      <header className="lab-heading">
        <button
          type="button"
          className="lab-menu"
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-controls="studio-sidebar"
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          {menuOpen ? <X size={17} /> : <Menu size={17} />}
        </button>
        <h1>
          Every note, <em>in its place.</em>
        </h1>
        <div className="lab-heading-actions">
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
        <VinylDeck
          playing={playing && followSong}
          playbackStatus={deckSession.playbackStatus}
          positionMs={mediaSession.positionMs}
          durationMs={mediaSession.durationMs}
          interactive={vinylInteractive}
          onPause={() => {
            setHeldPlaybackStatus('paused');
            void controlMediaPlayback('pause');
          }}
          onPlay={() => {
            setHeldPlaybackStatus('playing');
            void controlMediaPlayback('play');
          }}
          onSeek={(positionMs) => {
            void seekMedia(positionMs);
          }}
          onCue={setCuePositionMs}
        />

        <SourceStrip
          mediaSession={deckSession}
          detected={detectedKey}
          resolutionState={cloudResolution.resolutionState}
          keyName={activeDisplayName}
          certainty={fused.certainty}
          confidencePct={fused.confidencePct}
          notesSettled={fused.notesSettled}
          tonicSettled={fused.tonicSettled}
          relativeAlternative={fused.relativeAlternative}
          applyDetected={applyDetected}
          onToggleApply={toggleApplyDetected}
          applyThreshold={applyThreshold}
          onApplyThresholdChange={onApplyThresholdChange}
          cuePositionMs={cuePositionMs}
          capture={capture}
          scaleSaved={cloudResolution.cloudHit?.source === 'remembered'}
          onRememberScale={
            mediaSession.title?.trim() && fused.root && fused.scale
              ? () => {
                  void rememberScale({
                    title: mediaSession.title ?? '',
                    artist: mediaSession.artist ?? '',
                    key: fused.root ?? '',
                    mode: fused.scale ?? '',
                  });
                }
              : undefined
          }
        />

        <KeyReadout
          root={scale.root}
          scaleType={scaleType}
          notes={notes}
          sourceLabel={keySourceLabel({
            hasCloudHit: !!shownCloudHit,
            showingProposedKey,
          })}
          /* A hand-picked root is settled by definition — the open-tonic treatment belongs to the
             pipeline's own answer, not to a key the player chose. */
          tonicSettled={!showingProposedKey || fused.tonicSettled}
          relativeAlternative={showingProposedKey ? fused.relativeAlternative : null}
        />
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
            <h2>{title}</h2>
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
                onRootInputChange={(value) => {
                  dropApplyForHandEdit('root typed');
                  onRootInputChange(value);
                }}
                rootInvalid={rootInvalid}
                scaleType={scaleType}
                onScaleTypeChange={(value) => {
                  dropApplyForHandEdit('scale picked');
                  onScaleTypeChange(value);
                }}
                tuningId={tuningId}
                onTuningChange={onTuningChange}
                capo={capo}
                onCapoChange={onCapoChange}
                onRestoreDefault={handleRestoreDefault}
                onFlipRelative={() => {
                  dropApplyForHandEdit('flipped to the relative');
                  onFlipRelative();
                }}
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

      <section id="lab-chord-bank" className="lab-bank">
        <div className="lab-bank-heading">
          <div>
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
      </section>

      <DevDrawer
        open={devOpen}
        onClose={() => setDevOpen(false)}
        mediaSession={mediaSession}
        detected={detectedKey}
        detectedKeyAb={detectedKeyAb}
        cloudResolution={cloudResolution}
        activeDisplayName={activeDisplayName}
        fused={fused}
        applyDetected={applyDetected}
        applyThreshold={applyThreshold}
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
