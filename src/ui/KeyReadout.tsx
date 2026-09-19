import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { SCALE_DEGREE_LABELS, type ScaleNote } from '../scaleSpell';
import { SCALE_TYPE_LABELS, type ScaleType } from '../scaleDataProvider';

export type KeyReadoutProps = {
  root: string;
  scaleType: ScaleType;
  notes: ScaleNote[];
  /** Where the shown key came from: "Verified", "Catalog" or "Detected". */
  sourceLabel: string;
};

/**
 * The instrument's main display, wearing the Jam key card. This is the single largest element on
 * the panel by design — a player glancing over from three metres away should be able to read the
 * key and nothing else. The milled degree ruler stays: it is the Lab's, not Jam's.
 */
export function KeyReadout({ root, scaleType, notes, sourceLabel }: KeyReadoutProps) {
  const degreeLabels = SCALE_DEGREE_LABELS[scaleType];

  return (
    <div className="lab-key-card">
      <span className="lab-module-label">Key on the neck</span>

      <div aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${root}-${scaleType}`}
            className="lab-key-value"
            initial={{ opacity: 0, filter: 'blur(3px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <strong data-testid="jam-key">{root}</strong>
            <span>{SCALE_TYPE_LABELS[scaleType]}</span>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Scale tones as a milled ruler: fixed cells, degree engraved beneath each note. */}
      <div
        className="lab-ruler"
        style={{
          gridTemplateColumns: `repeat(${notes.length}, minmax(0, 1fr))`,
        }}
        aria-label="Scale tones"
      >
        {notes.map((note, i) => (
          <motion.div
            key={`pc-${note.pitchClass}`}
            layout
            transition={{ type: 'spring', stiffness: 340, damping: 36 }}
            className={note.isRoot ? 'is-root' : undefined}
          >
            <b>{note.label}</b>
            {/* Not uppercased: "b3" is a flattened third, "B3" would read as the note B. */}
            <small>{degreeLabels[i] ?? ''}</small>
          </motion.div>
        ))}
      </div>

      <span className="lab-source">
        <Sparkles size={13} />
        {sourceLabel} key
      </span>
    </div>
  );
}
