import { useEffect, useMemo, useState } from 'react';
import GuitarScaleView from './GuitarScaleView';
import type { PracticeSession } from './practice/session';
import { relativeKey } from './scaleSpell';
import {
  getBrainDefaultScale,
  tryNormalizeRoot,
  SCALE_TYPE_LABELS,
  type ScaleContext,
  type ScaleType,
} from './scaleDataProvider';
import { trace } from './services/debugLog';

type Props = {
  root: string;
  scaleType: ScaleType;
  tuningId: string;
  capo: number;
  /** 0–100: how sure the pipeline must be before Apply moves the neck. Lives in the session. */
  applyThreshold: number;
  onChange: (patch: Partial<PracticeSession>) => void;
  /** The shell's navigation drawer, opened from this screen's own hamburger. */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** False while the screen stays mounted behind another workspace. */
  followSong?: boolean;
};

/**
 * Live Jam: the detailed neck in `fretboard/Fretboard` with the `ui/` control face, driven by the
 * Studio's shared session so the key you land on here is the key the other screens practice.
 * Everything musical lives in the session; the only local state is the half-typed root, which is
 * a keystroke, not a key.
 */
export default function LiveJamScreen({
  root,
  scaleType,
  tuningId,
  capo,
  applyThreshold,
  onChange,
  menuOpen,
  onToggleMenu,
  followSong = true,
}: Props) {
  const [rootDraft, setRootDraft] = useState<string | null>(null);

  /* Drop the draft once the session moves somewhere the draft does not spell (detection, a favorite). */
  useEffect(() => {
    setRootDraft((draft) => (draft !== null && tryNormalizeRoot(draft) === root ? draft : null));
  }, [root]);

  const rootInput = rootDraft ?? root;
  const normalizedRoot = tryNormalizeRoot(rootInput);
  const rootInvalid = rootInput.trim().length > 0 && normalizedRoot === null;

  const scale: ScaleContext = useMemo(
    () => ({
      root,
      scaleType,
      title: `${root} ${SCALE_TYPE_LABELS[scaleType]}`,
    }),
    [root, scaleType],
  );

  /* The board keeps the last valid root, so an invalid keystroke never blanks the neck. */
  const handleRootInputChange = (value: string) => {
    setRootDraft(value);
    const next = tryNormalizeRoot(value);
    if (next !== null && next !== root) {
      onChange({ root: next });
    }
  };

  const resetToBrainKey = () => {
    const d = getBrainDefaultScale();
    trace('ui', 'reset', `Restoring the board to the brain default ${d.root} ${d.scaleType}`, {
      root: d.root,
      scaleType: d.scaleType,
    }, 'decide');
    onChange({ root: d.root, scaleType: d.scaleType });
  };

  const applyDetectedKey = (detectedRoot: string, detectedScale: 'major' | 'minor') => {
    trace('ui', 'board.key', `Fretboard root/scale set to ${detectedRoot} ${detectedScale}`, {
      root: detectedRoot,
      scaleType: detectedScale,
      previousRoot: root,
      previousScale: scaleType,
    }, 'ok');
    onChange({ root: detectedRoot, scaleType: detectedScale });
  };

  const flipRelative = () => {
    const relative = relativeKey(root, scaleType);
    if (relative === null) {
      trace('ui', 'relative.skip', `No relative key for ${root} ${scaleType}`, {
        root,
        scaleType,
        why: 'no_relative',
      }, 'skip');
      return;
    }
    trace('ui', 'relative.flip', `Flipped ${root} ${scaleType} → ${relative.root} ${relative.scaleType}`, {
      from: `${root} ${scaleType}`,
      to: `${relative.root} ${relative.scaleType}`,
    }, 'ok');
    onChange({ root: relative.root, scaleType: relative.scaleType });
  };

  return (
    <div className="lab-shell flex flex-1 flex-col" aria-label="Live Jam workspace" role="region">
      <GuitarScaleView
        scale={scale}
        rootInput={rootInput}
        onRootInputChange={handleRootInputChange}
        rootInvalid={rootInvalid}
        scaleType={scaleType}
        onScaleTypeChange={(next) => onChange({ scaleType: next })}
        tuningId={tuningId}
        onTuningChange={(next) => onChange({ tuningId: next })}
        capo={capo}
        onCapoChange={(next) => onChange({ capo: next })}
        applyThreshold={applyThreshold}
        onApplyThresholdChange={(next) => onChange({ applyThreshold: next })}
        onResetToBrainKey={resetToBrainKey}
        onApplyDetectedKey={applyDetectedKey}
        onFlipRelative={flipRelative}
        menuOpen={menuOpen}
        onToggleMenu={onToggleMenu}
        followSong={followSong}
      />
    </div>
  );
}
