import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { ScaleType } from './scaleDataProvider';
import { ChordDiagram } from './ChordDiagram';
import { getDiatonicTriads, isHeptatonicScaleType } from './chords/scaleChordTheory';
import { resolveChordVoicings } from './chords/resolveChordVoicings';
import type { ScaleChordWithVoicings } from './chords/chordTypes';
import { Led, Legend, Panel, Well } from './ui/gear';

export type ChordLibrarySectionProps = {
  root: string;
  scaleType: ScaleType;
  tuningId: string;
  /** Open-string pitch class per string; used only for the fretboard match highlight in diagrams. */
  openStringPcs: readonly number[];
  /** e.g. "Standard (E A D G B E)" — display only. */
  tuningLabel: string;
  /** One label per string (6 → 1, low → high) — display only, shown on diagrams. */
  stringLabels: readonly string[];
  capo: number;
  selectedChord: ScaleChordWithVoicings | null;
  onChordSelect: (chord: ScaleChordWithVoicings | null) => void;
};

function chordKey(c: ScaleChordWithVoicings): string {
  return `${c.degree}-${c.chordName}`;
}

/** A small engraved chip for panel metadata — tuning, capo, diagram legend. */
function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      className="gear-well inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[3px] px-2 py-[3px] text-[10px] text-gear-engrave"
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * The chord bank: one module per diatonic degree, laid out as a channel strip row. Engaging a
 * module lights it and pushes its tones onto the neck.
 */
function ChordLibrarySectionView({
  root,
  scaleType,
  tuningId,
  openStringPcs,
  tuningLabel,
  stringLabels,
  capo,
  selectedChord,
  onChordSelect,
}: ChordLibrarySectionProps) {
  const chords = useMemo(() => {
    const triads = getDiatonicTriads(root, scaleType);
    return resolveChordVoicings(triads, {
      tuningId,
      openStringPcs,
      capo,
      numFrets: 24,
    });
  }, [root, scaleType, tuningId, openStringPcs, capo]);

  const heptatonic = isHeptatonicScaleType(scaleType);

  return (
    <section className="shrink-0 px-3 pb-6 pt-4 sm:px-5 lg:px-8" aria-label="Chord bank for current scale">
      <Panel className="p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Legend className="shrink-0">Chord bank</Legend>
          <span className="text-[11px] text-gear-engrave">Engage a module to light its tones on the neck</span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
            {capo > 0 ? (
              <Chip>
                <Led tone="hold" size={5} />
                Capo {capo} · diagram frets from the nut
              </Chip>
            ) : null}
            <Chip title={tuningLabel}>
              <span className="shrink-0 font-semibold text-gear-legend">Tuning</span>
              <span className="min-w-0 truncate">{tuningLabel}</span>
            </Chip>
            <Chip title="How to read the diagrams">
              <span className="font-mono">6→1</span>
              <span className="text-gear-engrave/50">·</span>
              <span className="font-semibold">×</span> mute
              <span className="text-gear-engrave/50">·</span>
              <span className="inline-block h-2 w-2 rounded-full border border-gear-engrave" /> open
            </Chip>
          </div>
        </div>

        {tuningId !== 'standard' ? (
          <p className="mb-3 text-[11px] text-led-hold/80">
            Non-standard tuning: fewer stock shapes, so some modules show auto-found voicings.
          </p>
        ) : null}

        {!heptatonic ? (
          <Well className="px-4 py-8 text-center">
            <p className="text-[13px] text-gear-legend">Diatonic chords need a seven-note scale.</p>
            <p className="mt-1 text-[11px] text-gear-engrave">
              Switch to a major, minor or modal scale to populate the bank.
            </p>
          </Well>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            {chords.map((ch) => {
              const key = chordKey(ch);
              const isSel = selectedChord !== null && chordKey(selectedChord) === key;
              const displayVoicings = ch.displayVoicings;

              return (
                <motion.article
                  key={key}
                  layout
                  transition={{ type: 'spring', stiffness: 400, damping: 38 }}
                  className="relative flex min-w-0 flex-col overflow-hidden rounded-[4px]"
                  style={{
                    background: 'linear-gradient(180deg,#212127 0%,#1a1a1e 42%,#131316 100%)',
                    boxShadow: isSel
                      ? 'inset 0 0 0 1px rgba(240,165,42,0.55), 0 0 18px -4px rgba(240,165,42,0.3), var(--bevel-raised)'
                      : 'var(--bevel-raised)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onChordSelect(isSel ? null : ch)}
                    className="flex w-full flex-col items-stretch p-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gear-accent/70"
                    aria-pressed={isSel}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Led tone={isSel ? 'hold' : 'off'} size={6} />
                        <p
                          className={`min-w-0 truncate text-[19px] font-extrabold leading-none tracking-[-0.02em] ${
                            isSel ? 'text-gear-accent' : 'text-gear-text'
                          }`}
                        >
                          {ch.chordName}
                        </p>
                      </div>
                      {/* Not uppercased: lower-case numerals mark minor triads, upper-case major ones. */}
                      <span className="gear-engraved shrink-0 text-[11px] font-semibold tracking-[0.05em]">
                        {ch.degree}
                      </span>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      {displayVoicings.length > 0 ? (
                        displayVoicings.map((item, idx) => (
                          <Well key={`${item.shape}-${idx}`} className="px-2 pb-2 pt-1.5">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[10px] font-semibold text-gear-legend">
                                {item.type}
                              </span>
                              <span className="shrink-0 font-mono text-[10px] text-gear-engrave">{item.shape}</span>
                            </div>
                            <div className="flex justify-center">
                              <ChordDiagram
                                voicing={item.voicing}
                                isSelected={isSel && idx === 0}
                                size={idx === 0 ? 'md' : 'sm'}
                                rootPitchClass={ch.rootPitchClass}
                                openStringPcs={openStringPcs}
                                stringLabels={stringLabels}
                              />
                            </div>
                          </Well>
                        ))
                      ) : (
                        <Well className="flex min-h-[9rem] flex-col items-center justify-center gap-1 px-2 py-4 text-center">
                          <p className="text-[12px] text-gear-legend">No shape in range</p>
                          <p className="text-[10px] text-gear-engrave">Try another capo or tuning.</p>
                        </Well>
                      )}
                    </div>
                  </button>
                </motion.article>
              );
            })}
          </div>
        )}
      </Panel>
    </section>
  );
}

/** Same reason as the neck: the chord bank does not depend on playback position. */
export const ChordLibrarySection = memo(ChordLibrarySectionView);
