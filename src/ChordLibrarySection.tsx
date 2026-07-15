import { useMemo } from 'react';
import { motion } from 'framer-motion';
import type { ScaleType } from './scaleDataProvider';
import { ChordDiagram } from './ChordDiagram';
import { getDiatonicTriads, isHeptatonicScaleType } from './chords/scaleChordTheory';
import { resolveChordVoicings } from './chords/resolveChordVoicings';
import type { ScaleChordWithVoicings } from './chords/chordTypes';

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

export function ChordLibrarySection({
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
    <motion.section
      className="mt-10 w-full max-w-none px-2 sm:mt-12 sm:px-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Chord library for current scale"
    >
      <div className="mb-6 border-b border-white/[0.06] pb-5">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">
          Chords in this key
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-500">
          Diatonic triads for this scale.{' '}
          <span className="text-zinc-400/95">Tap a card</span> to highlight those notes on the neck.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-zinc-900/50 px-2.5 py-1 text-zinc-400">
            <span className="font-mono text-[10px] text-zinc-500">6→1</span>
            thick string (low) on the left, thin (high) on the right
          </span>
          <span
            className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-zinc-900/50 px-2.5 py-1"
            title="How to read the diagrams"
          >
            <span className="font-semibold text-zinc-500">×</span>
            <span>don’t play</span>
            <span className="text-zinc-600">·</span>
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-zinc-500" />
            <span>open</span>
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {capo > 0 ? (
            <span className="inline-flex items-center rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-sky-200/90">
              Capo {capo} · frets on diagrams are from the nut
            </span>
          ) : null}
          <span className="inline-flex max-w-full items-center rounded-full border border-white/[0.07] bg-zinc-900/40 px-2.5 py-0.5 text-[11px] text-zinc-500">
            <span className="shrink-0 font-semibold text-zinc-400">Tuning</span>
            <span className="mx-1.5 text-zinc-600">·</span>
            <span className="min-w-0 truncate" title={tuningLabel}>
              {tuningLabel}
            </span>
          </span>
          {tuningId !== 'standard' ? (
            <span className="text-xs text-amber-200/75">Non-standard: fewer stock shapes; auto-found shapes may appear as “Found”.</span>
          ) : null}
        </div>
      </div>

      {!heptatonic ? (
        <p className="rounded-2xl border border-zinc-800/80 bg-zinc-950/50 px-4 py-6 text-center text-sm text-zinc-400">
          Diatonic chord library is available for seven-note scales. Switch to a major, minor, or mode to see chords here.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {chords.map((ch) => {
            const key = chordKey(ch);
            const isSel = selectedChord !== null && chordKey(selectedChord) === key;
            const displayVoicings = ch.displayVoicings;

            return (
              <motion.article
                key={key}
                layout
                className={`group relative flex flex-col overflow-hidden rounded-2xl border transition-[box-shadow,transform,border-color] duration-200 ${
                  isSel
                    ? 'border-sky-500/45 bg-zinc-900/80 shadow-[0_0_0_1px_rgba(56,189,248,0.2),0_20px_50px_-24px_rgba(0,0,0,0.85)]'
                    : 'border-white/[0.07] bg-zinc-950/60 shadow-[0_16px_48px_-28px_rgba(0,0,0,0.75)] hover:-translate-y-0.5 hover:border-white/[0.12]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onChordSelect(isSel ? null : ch)}
                  className="flex w-full flex-col items-stretch p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35"
                  aria-pressed={isSel}
                >
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-2xl font-bold tracking-tight text-zinc-50 sm:text-[1.65rem]">
                        {ch.chordName}
                      </p>
                      <p className="mt-1.5 inline-block rounded-md border border-white/[0.06] bg-zinc-900/60 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-300">
                        {ch.degree}
                      </p>
                    </div>
                    <span className="rounded-md border border-white/[0.08] bg-zinc-900/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      {displayVoicings.length} shape{displayVoicings.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-3">
                    {displayVoicings.length > 0 ? (
                      displayVoicings.map((item, idx) => (
                        <div
                          key={`${item.shape}-${idx}`}
                          className="rounded-xl border border-white/[0.05] bg-black/25 px-3 pb-3 pt-2.5"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="truncate text-[11px] font-semibold text-zinc-300">
                              {item.type}
                            </span>
                            <span className="font-mono text-[11px] text-zinc-500">{item.shape}</span>
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
                        </div>
                      ))
                    ) : (
                      <div className="flex min-h-[9.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-white/[0.05] bg-black/20 px-2 py-4 text-center">
                        <p className="text-sm font-medium text-zinc-400">No shape in this view</p>
                        <p className="text-xs text-zinc-600">Try another capo or tuning.</p>
                      </div>
                    )}
                  </div>
                </button>
              </motion.article>
            );
          })}
        </div>
      )}
    </motion.section>
  );
}
