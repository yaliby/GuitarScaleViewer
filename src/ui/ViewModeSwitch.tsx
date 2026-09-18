import type { FretboardViewMode } from '../fretboard/geometry';
import { GearToggle, Legend } from './gear';

const MODES: ReadonlyArray<{ mode: FretboardViewMode; label: string }> = [
  { mode: 'scale-all', label: 'All' },
  { mode: 'root-only', label: 'Root' },
  { mode: 'triads', label: 'Triads' },
  { mode: 'chromatic', label: 'Chromatic' },
  { mode: 'scale-plus-pentatonic', label: '+ Pent' },
];

/**
 * The neck's display mode, as a bank of latching toggles. Sits directly under the neck because
 * that is the only thing it affects.
 */
export function ViewModeSwitch({
  value,
  onChange,
}: {
  value: FretboardViewMode;
  onChange: (mode: FretboardViewMode) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="Fretboard display mode">
      <Legend className="shrink-0">Display</Legend>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {MODES.map(({ mode, label }) => (
          <GearToggle key={mode} engaged={value === mode} onClick={() => onChange(mode)}>
            {label}
          </GearToggle>
        ))}
      </div>
    </div>
  );
}
