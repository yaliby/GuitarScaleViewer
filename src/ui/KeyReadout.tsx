import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { SCALE_DEGREE_LABELS, type ScaleNote } from '../scaleSpell';
import { SCALE_TYPE_LABELS, type ScaleType } from '../scaleDataProvider';

export type KeyReadoutProps = {
  root: string;
  scaleType: ScaleType;
  notes: ScaleNote[];
  /** Where the shown key came from: "Verified" or "Detected". */
  sourceLabel: string;
  /**
   * False when the engine cannot separate this key from its relative. The seven notes below are
   * right either way; the root marker and the degree ruler are the half that is a coin flip.
   */
  tonicSettled?: boolean;
  /** The other reading of the same notes, shown so the player can judge it at a glance. */
  relativeAlternative?: string | null;
};

/**
 * The instrument's main display, wearing the Jam key card. This is the single largest element on
 * the panel by design — a player glancing over from three metres away should be able to read the
 * key and nothing else. The milled degree ruler stays: it is the Lab's, not Jam's.
 *
 * When the tonic is open the card does not hide the answer and does not hedge the whole display:
 * the note row stays at full strength because it is correct, and only the root marker and the
 * degree numbers — the parts that actually depend on which note is home — step back. Asserting a
 * root the engine did not earn is what sent players to the `Relative` button, and pressing a
 * button is the one thing this app promises they will never have to do.
 */
export function KeyReadout({
  root,
  scaleType,
  notes,
  sourceLabel,
  tonicSettled = true,
  relativeAlternative = null,
}: KeyReadoutProps) {
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
        {!tonicSettled && relativeAlternative ? (
          <p className="lab-key-alt" data-testid="jam-key-alt">
            or <b>{relativeAlternative}</b> — same notes
          </p>
        ) : null}
      </div>

      {/* Scale tones as a milled ruler: fixed cells, degree engraved beneath each note. */}
      <div
        className={`lab-ruler${tonicSettled ? '' : ' is-tonic-open'}`}
        style={{
          gridTemplateColumns: `repeat(${notes.length}, minmax(0, 1fr))`,
        }}
        aria-label={tonicSettled ? 'Scale tones' : 'Scale tones — root not yet resolved'}
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
