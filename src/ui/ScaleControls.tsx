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

/** One labelled control cell. Keeps the legend/field rhythm identical across the whole panel. */
function Field({
  label,
  children,
  className = '',
  hint,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  hint?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <Legend>{label}</Legend>
      {children}
      {hint ? <span className="text-[10px] leading-tight text-led-fault/90">{hint}</span> : null}
    </label>
  );
}

/** The tonic, scale, tuning and capo — everything that decides what the neck draws. */
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
    <div className="flex w-full min-w-0 flex-wrap items-start gap-x-3 gap-y-3">
      <Field
        label="Root"
        className="w-[5.5rem] shrink-0"
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

      <Field label="Scale" className="min-w-[11rem] flex-1 basis-48">
        <GearSelect value={scaleType} onChange={(e) => onScaleTypeChange(e.target.value as ScaleType)}>
          {SCALE_TYPES_ORDERED.map((t) => (
            <option key={t} value={t}>
              {SCALE_TYPE_LABELS[t]}
            </option>
          ))}
        </GearSelect>
      </Field>

      <Field label="Tuning" className="min-w-[11rem] flex-1 basis-48">
        <GearSelect value={tuningId} onChange={(e) => onTuningChange(e.target.value)}>
          {TUNING_PRESETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </GearSelect>
      </Field>

      <Field label="Capo" className="w-[6.5rem] shrink-0">
        <GearSelect value={String(capo)} onChange={(e) => onCapoChange(Number(e.target.value))}>
          <option value="0">None</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((f) => (
            <option key={f} value={String(f)}>
              Fret {f}
            </option>
          ))}
        </GearSelect>
      </Field>

      <div className="flex flex-col gap-1.5 self-start">
        <Legend className="opacity-0" aria-hidden="true">
          .
        </Legend>
        <div className="flex items-center gap-2">
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
          <GearButton onClick={onRestoreDefault} title="Back to the engine default key, standard tuning, no capo">
            Restore
          </GearButton>
        </div>
      </div>
    </div>
  );
}
