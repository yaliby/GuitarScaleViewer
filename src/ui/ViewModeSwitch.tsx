import type { FretboardViewMode } from '../fretboard/geometry';
import { Led } from './gear';

const MODES: ReadonlyArray<{ mode: FretboardViewMode; label: string }> = [
  { mode: 'scale-all', label: 'All' },
  { mode: 'root-only', label: 'Root' },
  { mode: 'triads', label: 'Triads' },
  { mode: 'chromatic', label: 'Chromatic' },
  { mode: 'scale-plus-pentatonic', label: '+ Pent' },
];

/**
 * The neck's display mode, as a segmented bar in the neck's own heading — right beside the only
 * thing it affects. The engaged segment keeps its lamp, so the bank still reads as a switch bank.
 */
export function ViewModeSwitch({
  value,
  onChange,
}: {
  value: FretboardViewMode;
  onChange: (mode: FretboardViewMode) => void;
}) {
  return (
    <div className="lab-segmented" role="group" aria-label="Fretboard display mode">
      {MODES.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          className={value === mode ? 'selected' : ''}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          <Led tone={value === mode ? 'hold' : 'off'} size={5} />
          {label}
        </button>
      ))}
    </div>
  );
}
