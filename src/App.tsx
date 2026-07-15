import { useMemo, useRef, useState } from 'react';
import GuitarScaleView from './GuitarScaleView';
import {
  getBrainDefaultScale,
  tryNormalizeRoot,
  SCALE_TYPE_LABELS,
  type ScaleContext,
  type ScaleType,
} from './scaleDataProvider';

export default function App() {
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
    setRootInput(d.root);
    setScaleType(d.scaleType);
  };

  const applyDetectedKey = (root: string, detectedScale: 'major' | 'minor') => {
    setRootInput(root);
    setScaleType(detectedScale);
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
      />
    </div>
  );
}
