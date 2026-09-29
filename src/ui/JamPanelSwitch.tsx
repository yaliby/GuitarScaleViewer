import type { JamPanel, SheetStatus } from '../jamPanel';
import { Led } from './gear';

const PANELS: ReadonlyArray<{ panel: JamPanel; label: string }> = [
  { panel: 'chords', label: 'Key chords' },
  { panel: 'chart', label: 'Chart' },
  { panel: 'sheet', label: 'Song sheet' },
];

const SHEET_TITLE: Record<SheetStatus, string> = {
  none: 'No song sheet for this song yet',
  working: 'This song is being read in the background',
  ready: 'This song’s sheet is ready',
};

/**
 * What the bay under the neck shows, in the same switch bank as the neck's display mode. The
 * engaged segment keeps its lamp; the song sheet's lamp otherwise says how far this song's
 * background analysis has got: breathing while it is read, lit once its sheet is ready.
 */
export function JamPanelSwitch({
  value,
  onChange,
  sheet,
}: {
  value: JamPanel;
  onChange: (panel: JamPanel) => void;
  sheet: SheetStatus;
}) {
  return (
    <div className="lab-segmented" role="group" aria-label="Under the neck">
      {PANELS.map(({ panel, label }) => {
        const selected = value === panel;
        const status = panel === 'sheet' ? sheet : null;
        return (
          <button
            key={panel}
            type="button"
            className={selected ? 'selected' : ''}
            aria-pressed={selected}
            title={status ? SHEET_TITLE[status] : undefined}
            onClick={() => onChange(panel)}
          >
            <Led
              tone={selected ? 'hold' : status === 'ready' ? 'live' : status === 'working' ? 'data' : 'off'}
              pulse={!selected && status === 'working'}
              size={5}
            />
            {label}
          </button>
        );
      })}
    </div>
  );
}
