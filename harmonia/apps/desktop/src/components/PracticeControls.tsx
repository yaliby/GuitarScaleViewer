// @ts-nocheck
import { memo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChordDisplayMode } from '../../../../packages/domain/notation';
export const PracticeControls = memo(function PracticeControls({
  transpose,
  onChange,
  mode,
  onModeChange,
  hasKey,
}: {
  transpose: number;
  onChange: Dispatch<SetStateAction<number>>;
  mode: ChordDisplayMode;
  onModeChange: (mode: ChordDisplayMode) => void;
  hasKey: boolean;
}) {
  return (
    <div className="practice-row">
      <div>
        <span className="eyebrow">MAKE IT YOURS</span>
        <p>Slow it down. Find the shape. Play it your way.</p>
      </div>
      <label className="notation-picker">
        Chord notation
        <select
          value={mode}
          onChange={(event) => onModeChange(event.target.value as ChordDisplayMode)}
        >
          <option value="advanced">Full chords</option>
          <option value="simple">Simplified chords</option>
          <option value="roman" disabled={!hasKey}>
            Roman numerals
          </option>
          <option value="nashville" disabled={!hasKey}>
            Nashville numbers
          </option>
        </select>
        <small>
          {hasKey
            ? 'Degrees follow the displayed key; slash bass uses numbers.'
            : 'A key estimate is needed for numbers.'}
        </small>
      </label>
      <div className="transpose">
        <span>
          Display transpose <small>notation only</small>
        </span>
        <button
          className="icon-button"
          aria-label="Transpose down"
          disabled={transpose <= -12}
          onClick={() => onChange((v) => v - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <strong>
          {transpose > 0 ? '+' : ''}
          {transpose}
        </strong>
        <button
          className="icon-button"
          aria-label="Transpose up"
          disabled={transpose >= 12}
          onClick={() => onChange((v) => v + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
});
