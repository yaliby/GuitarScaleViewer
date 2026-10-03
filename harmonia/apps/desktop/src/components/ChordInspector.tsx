// @ts-nocheck
import { memo, useMemo, useState } from 'react';
import { chordPitchClasses, formatChord, pitchName } from '../../../../packages/domain/chord';
import { displayChord } from '../../../../packages/domain/notation';
import type { Chord, ChordSegment } from '../../../../packages/domain/types';
import { Piano, Guitar } from './Instrument';
import { GuitarDiagram, PianoDiagram } from './PracticeDiagrams';
import { getGuitarVoicings, getPianoVoicings } from '../../../../packages/domain/practice-voicings';
interface ChordInspectorProps {
  practiceVoicings?: {
    piano: ReturnType<typeof getPianoVoicings>;
    guitar: ReturnType<typeof getGuitarVoicings>;
    capo: number;
    shapeLabel?: string;
  };
  segment: ChordSegment | undefined;
  index: number;
  transpose: number;
  onSelectChord: (segmentId: string, chord: Chord) => void;
}
export const ChordInspector = memo(function ChordInspector({
  segment,
  index,
  transpose,
  onSelectChord,
  practiceVoicings,
}: ChordInspectorProps) {
  const [instrument, setInstrument] = useState<'piano' | 'guitar' | 'tones'>('piano');
  const chord = segment?.chord ?? { kind: 'unknown' as const };
  const voicings = useMemo(
    () => practiceVoicings ?? { piano: getPianoVoicings(chord), guitar: getGuitarVoicings(chord) },
    [chord, practiceVoicings],
  );
  const piano = voicings.piano.voicings[0];
  const guitar = voicings.guitar.voicings[0];
  return (
    <aside className="inspector" aria-label="Harmony inspector">
      <div className="section-heading">
        <span className="eyebrow">INSIDE THE CHORD</span>
        <span className="small-index">{segment ? String(index + 1).padStart(2, '0') : '—'}</span>
      </div>
      <h2>{segment ? displayChord(chord, 'advanced', null) : '—'}</h2>
      <p className="chord-description">
        {chord.kind === 'chord'
          ? `${chord.triad} · ${chord.seventh ? `${chord.seventh} seventh` : 'triad'}`
          : 'No harmonic label'}
      </p>
      <div className="tones">
        {chordPitchClasses(chord).map((pc, i) => (
          <span
            className={chord.kind === 'chord' && pc === chord.root ? 'root-tone' : ''}
            key={`${pc}-${i}`}
          >
            {pitchName(pc, chord.kind === 'chord' ? chord.spelling : 'sharp')}
          </span>
        ))}
      </div>
      <div className="instrument-tabs" role="group" aria-label="Current chord instrument">
        <button
          className={instrument === 'piano' ? 'selected' : ''}
          aria-pressed={instrument === 'piano'}
          onClick={() => setInstrument('piano')}
        >
          Piano
        </button>
        <button
          className={instrument === 'guitar' ? 'selected' : ''}
          aria-pressed={instrument === 'guitar'}
          onClick={() => setInstrument('guitar')}
        >
          Guitar
        </button>
        <button
          className={instrument === 'tones' ? 'selected' : ''}
          aria-pressed={instrument === 'tones'}
          onClick={() => setInstrument('tones')}
        >
          Tone maps
        </button>
      </div>
      {instrument === 'piano' &&
        (piano && chord.kind === 'chord' ? (
          <>
            <PianoDiagram
              voicing={piano}
              label={formatChord(chord)}
              root={chord.root}
              spelling={chord.spelling}
            />
            {voicings.piano.explanation && (
              <p className="voicing-note">{voicings.piano.explanation}</p>
            )}
          </>
        ) : (
          <p>No piano voicing for this interval.</p>
        ))}
      {instrument === 'guitar' && (
        <>
          {practiceVoicings &&
            (practiceVoicings.capo > 0 || practiceVoicings.shapeLabel !== formatChord(chord)) && (
              <p className="voicing-note">
                Play {practiceVoicings.shapeLabel} shape
                {practiceVoicings.capo ? ` · capo on fret ${practiceVoicings.capo}` : ''}
              </p>
            )}
          {guitar ? (
            <GuitarDiagram
              voicing={guitar}
              label={practiceVoicings?.shapeLabel ?? formatChord(chord)}
            />
          ) : (
            <p>Guitar diagram unavailable</p>
          )}
          {voicings.guitar.explanation && (
            <p className="voicing-note">{voicings.guitar.explanation}</p>
          )}
        </>
      )}
      {instrument === 'tones' && (
        <>
          <p className="voicing-note">Reference maps — not a fingering to play all at once.</p>
          <Piano chord={chord} />
          <Guitar chord={chord} />
        </>
      )}
      <div className="inspector-details">
        <span>Bass note</span>
        <strong>
          {chord.kind === 'chord' ? pitchName(chord.bass ?? chord.root, chord.spelling) : '—'}
        </strong>
        <span>Duration</span>
        <strong>{segment ? (segment.end - segment.start).toFixed(2) : '—'} s</strong>
      </div>
      {segment && segment.alternatives.length > 0 && (
        <div className="alternatives">
          <span className="eyebrow">OTHER POSSIBILITIES</span>
          {segment.alternatives.slice(0, 2).map((a, i) => (
            <button
              key={i}
              disabled={transpose !== 0}
              onClick={() => onSelectChord(segment.id, a.chord)}
            >
              <span>{formatChord(a.chord)}</span>
              <small>{Math.round(a.score * 100)}% score</small>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
});
