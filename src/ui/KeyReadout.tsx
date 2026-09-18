import { motion } from 'framer-motion';
import { SCALE_DEGREE_LABELS, type ScaleNote } from '../scaleSpell';
import { SCALE_TYPE_LABELS, type ScaleType } from '../scaleDataProvider';
import { Legend, Well } from './gear';

export type KeyReadoutProps = {
  root: string;
  scaleType: ScaleType;
  notes: ScaleNote[];
  /** Where the shown key came from: "Verified", "Catalog" or "Detected". */
  sourceLabel: string;
};

/**
 * The instrument's main display. This is the single largest element on the panel by design —
 * a player glancing over from three metres away should be able to read the key and nothing else.
 */
export function KeyReadout({ root, scaleType, notes, sourceLabel }: KeyReadoutProps) {
  const degreeLabels = SCALE_DEGREE_LABELS[scaleType];

  return (
    <Well className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:px-5 sm:py-4">
      <div className="flex items-baseline justify-between gap-3">
        <Legend>Key</Legend>
        <span className="legend text-gear-accent/70">{sourceLabel}</span>
      </div>

      <div className="flex min-w-0 items-baseline gap-3">
        <motion.span
          key={root}
          initial={{ opacity: 0.35, filter: 'blur(3px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="shrink-0 font-sans text-[3.25rem] font-extrabold leading-[0.82] tracking-[-0.045em] text-gear-accent sm:text-[4rem]"
          style={{ textShadow: '0 0 22px rgba(240,165,42,0.32), 0 1px 0 rgba(0,0,0,0.9)' }}
        >
          {root}
        </motion.span>
        <span className="min-w-0 truncate pb-1 text-[13px] font-semibold uppercase tracking-[0.13em] text-gear-legend sm:text-sm">
          {SCALE_TYPE_LABELS[scaleType]}
        </span>
      </div>

      {/* Scale tones as a milled ruler: fixed cells, degree engraved beneath each note. */}
      <div
        className="grid min-w-0 gap-px overflow-hidden rounded-[3px] bg-black/60"
        style={{ gridTemplateColumns: `repeat(${notes.length}, minmax(0, 1fr))` }}
        aria-label="Scale tones"
      >
        {notes.map((note, i) => (
          <motion.div
            key={`pc-${note.pitchClass}`}
            layout
            transition={{ type: 'spring', stiffness: 340, damping: 36 }}
            className={`flex min-w-0 flex-col items-center gap-0.5 px-1 py-1.5 ${
              note.isRoot
                ? 'bg-[linear-gradient(180deg,#2a1d08_0%,#1d1406_100%)]'
                : 'bg-[linear-gradient(180deg,#17171c_0%,#111114_100%)]'
            }`}
          >
            <span
              className={`tele w-full truncate text-center text-[13px] font-bold leading-none sm:text-[15px] ${
                note.isRoot ? 'text-gear-accent' : 'text-gear-text/80'
              }`}
            >
              {note.label}
            </span>
            {/* Not uppercased: "b3" is a flattened third, "B3" would read as the note B. */}
            <span className="gear-engraved w-full truncate text-center text-[9px] font-semibold leading-none tracking-[0.06em]">
              {degreeLabels[i] ?? ''}
            </span>
          </motion.div>
        ))}
      </div>
    </Well>
  );
}
