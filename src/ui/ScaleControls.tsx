import { SCALE_TYPES_ORDERED, SCALE_TYPE_LABELS, type ScaleType } from '../scaleDataProvider';
import { TUNING_PRESETS } from '../tunings';
import { GearButton, GearInput, GearSelect, Legend } from './gear';

export type ScaleControlsProps = {
  rootInput: string;
  onRootInputChange: (value: string) => void;
  rootInvalid: boolean;
  scaleType: ScaleType;
  onScaleTypeChange: (value: ScaleType) => void;
  tuningId: string;
  onTuningChange: (value: string) => void;
  capo: number;
  onCapoChange: (value: number) => void;
  onRestoreDefault: () => void;
  /** Swap to the relative major/minor — same notes, tonal centre a third away. */
  onFlipRelative: () => void;
};

/** One labelled control cell. Keeps the legend/field rhythm identical across the whole row. */
function Field({
  label,
  children,
  style,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  hint?: string;
}) {
  return (
    <label style={style}>
      <Legend>{label}</Legend>
      {children}
      {hint ? <span className="text-[10px] leading-tight text-led-fault/90">{hint}</span> : null}
    </label>
  );
}

/**
 * The tonic, scale, tuning and capo — everything that decides what the neck draws. Opened from the
 * neck heading like Jam's manual row, but the fields stay milled into the panel: this is the one
 * place in the Lab where you set the instrument up, and it should still feel like one.
 */
export function ScaleControls({
  rootInput,
  onRootInputChange,
  rootInvalid,
  scaleType,
  onScaleTypeChange,
  tuningId,
  onTuningChange,
  capo,
  onCapoChange,
  onRestoreDefault,
  onFlipRelative,
}: ScaleControlsProps) {
  const hasRelative = scaleType === 'major' || scaleType === 'minor';
  return (
    <div className="lab-setup">
      <span className="lab-setup-caption">Make it yours</span>

      <Field
        label="Root"
        style={{ width: '5.5rem', flexShrink: 0 }}
        hint={rootInvalid ? 'A–G with # or b' : undefined}
      >
        <GearInput
          type="text"
          value={rootInput}
          onChange={(e) => onRootInputChange(e.target.value)}
          placeholder="A"
          spellCheck={false}
          invalid={rootInvalid}
          aria-invalid={rootInvalid}
          className="text-center text-[17px] font-bold tracking-tight"
        />
      </Field>

      <Field label="Scale" style={{ flex: '1 1 13rem', minWidth: '11rem' }}>
        <GearSelect value={scaleType} onChange={(e) => onScaleTypeChange(e.target.value as ScaleType)}>
          {SCALE_TYPES_ORDERED.map((t) => (
            <option key={t} value={t}>
              {SCALE_TYPE_LABELS[t]}
            </option>
          ))}
        </GearSelect>
      </Field>

      <Field label="Tuning" style={{ flex: '1 1 13rem', minWidth: '11rem' }}>
        <GearSelect value={tuningId} onChange={(e) => onTuningChange(e.target.value)}>
          {TUNING_PRESETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </GearSelect>
      </Field>

      <Field label="Capo" style={{ width: '7rem', flexShrink: 0 }}>
        <GearSelect value={String(capo)} onChange={(e) => onCapoChange(Number(e.target.value))}>
          <option value="0">None</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((f) => (
            <option key={f} value={String(f)}>
              Fret {f}
            </option>
          ))}
        </GearSelect>
      </Field>

      <div className="lab-setup-actions">
        <GearButton
          onClick={onFlipRelative}
          disabled={!hasRelative}
          title={
            hasRelative
              ? 'Switch to the relative major/minor: same notes, root moved a third'
              : 'Only major and minor have a relative key'
          }
        >
          Relative
        </GearButton>
        <GearButton
          onClick={onRestoreDefault}
          title="Back to the engine default key, standard tuning, no capo"
        >
          Restore
        </GearButton>
      </div>
    </div>
  );
}
