import { useMemo, useRef, useState } from 'react';
import GuitarScaleView from './GuitarScaleView';
import { relativeKey } from './scaleSpell';
import {
  getBrainDefaultScale,
  tryNormalizeRoot,
  SCALE_TYPE_LABELS,
  type ScaleContext,
  type ScaleType,
} from './scaleDataProvider';
import { trace } from './services/debugLog';

/**
 * The original Guitar Scale Viewer chassis, kept alongside Fretboard Studio as an
 * alternate view: it owns its own root/scale state and renders the detailed neck in
 * `fretboard/Fretboard` with the `ui/` control face. Studio switches to it by mode.
 */
export default function ClassicScaleView() {
  const [rootInput, setRootInput] = useState('A');
  const lastValidRoot = useRef('A');
  const [scaleType, setScaleType] = useState<ScaleType>('minor');

  const normalizedRoot = tryNormalizeRoot(rootInput);
  if (normalizedRoot !== null) {
    lastValidRoot.current = normalizedRoot;
  }
  const rootForBoard = normalizedRoot ?? lastValidRoot.current;

  const scale: ScaleContext = useMemo(
    () => ({
      root: rootForBoard,
      scaleType,
      title: `${rootForBoard} ${SCALE_TYPE_LABELS[scaleType]}`,
    }),
    [rootForBoard, scaleType],
  );

  const rootInvalid = rootInput.trim().length > 0 && normalizedRoot === null;

  const resetToBrainKey = () => {
    const d = getBrainDefaultScale();
    trace('ui', 'reset', `Restoring the board to the brain default ${d.root} ${d.scaleType}`, {
      root: d.root,
      scaleType: d.scaleType,
    }, 'decide');
    setRootInput(d.root);
    setScaleType(d.scaleType);
  };

  const applyDetectedKey = (root: string, detectedScale: 'major' | 'minor') => {
    trace('ui', 'board.key', `Fretboard root/scale set to ${root} ${detectedScale}`, {
      root,
      scaleType: detectedScale,
      previousRoot: rootForBoard,
      previousScale: scaleType,
    }, 'ok');
    setRootInput(root);
    setScaleType(detectedScale);
  };

  /* Reads off the board as shown, so a flip after an invalid keystroke still uses a real root. */
  const flipRelative = () => {
    const relative = relativeKey(rootForBoard, scaleType);
    if (relative === null) {
      trace('ui', 'relative.skip', `No relative key for ${rootForBoard} ${scaleType}`, {
        root: rootForBoard,
        scaleType,
        why: 'no_relative',
      }, 'skip');
      return;
    }
    trace('ui', 'relative.flip', `Flipped ${rootForBoard} ${scaleType} → ${relative.root} ${relative.scaleType}`, {
      from: `${rootForBoard} ${scaleType}`,
      to: `${relative.root} ${relative.scaleType}`,
    }, 'ok');
    setRootInput(relative.root);
    setScaleType(relative.scaleType);
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <GuitarScaleView
        scale={scale}
        rootInput={rootInput}
        onRootInputChange={setRootInput}
        rootInvalid={rootInvalid}
        scaleType={scaleType}
        onScaleTypeChange={setScaleType}
        onResetToBrainKey={resetToBrainKey}
        onApplyDetectedKey={applyDetectedKey}
        onFlipRelative={flipRelative}
      />
    </div>
  );
}
