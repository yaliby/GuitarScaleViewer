// @ts-nocheck
import { memo, useState } from 'react';
import type { buildPracticeArrangement } from '../../../../packages/domain/practice-arrangement';
import { GuitarDiagram, PianoDiagram } from './PracticeDiagrams';
import { timeLabel } from './Timeline';

// No playback time prop: aggregation and voicing selection only depend on the snapshot.
export const ChordLibrary = memo(function ChordLibrary({
  arrangement,
  transpose,
  onSeek,
  onModeChange,
  capoChoice,
  onCapoChange,
}: {
  arrangement: ReturnType<typeof buildPracticeArrangement>;
  transpose: number;
  onSeek(time: number): void;
  onModeChange(mode: 'classic' | 'easy'): void;
  capoChoice: number | 'recommended';
  onCapoChange(capo: number | 'recommended'): void;
}) {
  const [instrument, setInstrument] = useState<'guitar' | 'piano' | 'both'>('both');
  const { entries } = arrangement;
  return (
    <section className="chord-library" aria-label="Chord Library">
      <div className="practice-heading">
        <div>
          <span className="eyebrow">LEARN THE SONG</span>
          <h2>Chord Library</h2>
          <p>
            {entries.length} unique {entries.length === 1 ? 'chord' : 'chords'} · in order of first
            appearance
          </p>
        </div>
        <div className="instrument-tabs" role="group" aria-label="Library instrument">
          {(['guitar', 'piano', 'both'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={instrument === mode}
              className={instrument === mode ? 'selected' : ''}
              onClick={() => setInstrument(mode)}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="arrangement-controls">
        <div className="instrument-tabs" role="group" aria-label="Practice arrangement">
          {(['classic', 'easy'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={arrangement.mode === mode}
              className={arrangement.mode === mode ? 'selected' : ''}
              onClick={() => onModeChange(mode)}
            >
              {mode === 'classic' ? 'Classic shapes' : 'Easy practice'}
            </button>
          ))}
        </div>
        {arrangement.mode === 'easy' && (
          <label>
            Guitar capo{' '}
            <select
              aria-label="Guitar capo"
              value={capoChoice}
              onChange={(event) =>
                onCapoChange(
                  event.target.value === 'recommended' ? 'recommended' : Number(event.target.value),
                )
              }
            >
              <option value="recommended">
                Recommended:{' '}
                {arrangement.recommendedCapo ? `fret ${arrangement.recommendedCapo}` : 'no capo'}
              </option>
              <option value="0">No capo</option>
              {[1, 2, 3, 4, 5, 6, 7].map((fret) => (
                <option value={fret} key={fret}>
                  Fret {fret}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="library-guide">
        {arrangement.mode === 'classic'
          ? 'Classic chord shapes: familiar guitar positions and one compact piano chord. The same chord uses the same shape throughout the song.'
          : 'An easier arrangement. Chord titles retain the analyzed harmony; any omitted notes are shown.'}
      </p>
      {arrangement.mode === 'easy' && (
        <div className="capo-guidance">
          <strong>{arrangement.capo ? `Capo on fret ${arrangement.capo}` : 'No capo'}</strong>
          <p>
            {arrangement.capo
              ? 'Frets shown relative to the capo. Play the named shapes; piano remains in the sounding key.'
              : 'Shapes are shown in standard tuning.'}
          </p>
          <p>{arrangement.capoExplanation}</p>
        </div>
      )}
      {transpose !== 0 && (
        <p className="practice-transposition">
          Practice view {transpose > 0 ? '+' : ''}
          {transpose} {Math.abs(transpose) === 1 ? 'semitone' : 'semitones'} · audio unchanged
        </p>
      )}
      <p className="library-guide">
        Practice one shape at a time. Choose a timestamp to jump to it in the song.
      </p>
      <p className="library-guide">
        Guitar: ○ open · × muted · 1–4 fingers. Piano: play the highlighted keys together with one
        hand. Dots mark the root.
      </p>
      {!entries.length && <p>No playable chords in this timeline yet.</p>}
      <div className={`practice-chord-grid view-${instrument}`}>
        {entries.map((entry) => (
          <article
            className="practice-chord-card"
            data-testid="practice-chord-card"
            data-count={entry.count}
            key={entry.id}
          >
            <header>
              <h3>{entry.label}</h3>
              <div>
                <strong>
                  {entry.count} {entry.count === 1 ? 'appearance' : 'appearances'}
                </strong>
                <span>
                  {entry.totalDuration < 0.1 ? '<0.1' : entry.totalDuration.toFixed(1)} s in song
                </span>
              </div>
            </header>
            {entry.labels.length > 1 && (
              <p className="voicing-notes">
                Also written {entry.labels.filter((label) => label !== entry.label).join(', ')}
              </p>
            )}
            <div className="practice-diagrams">
              {instrument !== 'piano' && (
                <div className="practice-instrument">
                  <span className="eyebrow">GUITAR</span>
                  {(arrangement.capo > 0 || entry.shapeLabel !== entry.label) && (
                    <p className="voicing-notes">
                      Play {entry.shapeLabel} shape
                      {arrangement.capo ? ` · capo ${arrangement.capo}` : ''}
                    </p>
                  )}
                  {entry.guitar.voicings[0] ? (
                    <GuitarDiagram voicing={entry.guitar.voicings[0]} label={entry.shapeLabel} />
                  ) : (
                    <p className="diagram-unavailable">Guitar diagram unavailable</p>
                  )}
                  {entry.guitar.explanation && (
                    <p className="voicing-note">{entry.guitar.explanation}</p>
                  )}
                </div>
              )}
              {instrument !== 'guitar' && (
                <div className="practice-instrument">
                  <span className="eyebrow">PIANO</span>
                  {entry.piano.voicings[0] ? (
                    <PianoDiagram
                      voicing={entry.piano.voicings[0]}
                      label={entry.label}
                      root={entry.chord.root}
                      spelling={entry.chord.spelling}
                    />
                  ) : (
                    <p className="diagram-unavailable">Piano diagram unavailable</p>
                  )}
                  {entry.piano.explanation && (
                    <p className="voicing-note">{entry.piano.explanation}</p>
                  )}
                </div>
              )}
            </div>
            <div
              className="chord-occurrences"
              role="group"
              aria-label={`${entry.label} occurrences`}
            >
              {entry.occurrences.map((occurrence, i) => (
                <button
                  key={occurrence.segmentId}
                  data-start={occurrence.start}
                  aria-label={`Jump to ${entry.label} at ${timeLabel(occurrence.start)}, occurrence ${i + 1}`}
                  onClick={() => onSeek(occurrence.start)}
                >
                  {timeLabel(occurrence.start)}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
});
