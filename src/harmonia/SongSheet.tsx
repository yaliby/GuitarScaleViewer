import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Crosshair, RotateCw } from "lucide-react";
import { displayChord, type ChordDisplayMode } from "../../harmonia/packages/domain/notation";
import type { Analysis, ChordSegment } from "../../harmonia/packages/domain/types";
import { scrollLineToCenter } from "../playalong/scroll";
import { lyricStageLabel, type LyricMap } from "../services/lyricMap";
import {
  activeIndex,
  beatPlace,
  buildSongSheet,
  tuningNote,
  type SheetMark,
  type SheetRow,
  type SongSheet as Sheet,
} from "./chordSheet";
import "./SongSheet.css";

/** The beat grid the sheet counts in: only analyses that read bars (native v4) carry one. */
export type SheetRhythm = {
  beats: readonly number[];
  downbeats: readonly number[];
  tempo: number | null;
  meter: number | null;
  steady: boolean;
  tuningCents: number | null;
  duration: number;
};

export function sheetRhythm(analysis: Analysis): SheetRhythm | null {
  if (!analysis.grid) return null;
  return {
    beats: analysis.beats,
    downbeats: analysis.grid.downbeats,
    tempo: analysis.tempo,
    meter: analysis.meter,
    steady: analysis.grid.steady,
    tuningCents: analysis.tuningCents ?? null,
    duration: analysis.duration,
  };
}

export type LyricSheetState =
  | { status: "loading" }
  | { status: "mapping"; progress: number; stage: string }
  | { status: "ready"; map: LyricMap }
  | { status: "error"; message: string };

type Props = {
  lyrics: LyricSheetState;
  /** The analysis segments on screen (transposed when the listener transposes). */
  segments: readonly ChordSegment[];
  notation: ChordDisplayMode;
  keyRoot: number | null;
  time: number;
  playing: boolean;
  seekRevision: number;
  onSeek(seconds: number): void;
  onRetime(): void;
  /** Bars, tempo and tuning, when the analysis read them. */
  rhythm?: SheetRhythm | null;
};

/** A line lights up this much before its first word, so the eye is there in time. */
const ROW_AHEAD_S = 0.35;
/** After a hand scroll, the sheet waits this long before following the song again. */
const RESPITE_MS = 4000;

type Face = { label: string; hue: number | null };

function faceOf(segment: ChordSegment | undefined, notation: ChordDisplayMode, keyRoot: number | null): Face {
  if (!segment || segment.chord.kind !== "chord") return { label: "", hue: null };
  // One hue per root, the same wheel as the Play Along chart.
  return { label: displayChord(segment.chord, notation, keyRoot), hue: (40 + segment.chord.root * 30) % 360 };
}

function Mark({
  mark,
  face,
  on,
  onSeek,
  start,
}: {
  mark: SheetMark;
  face: Face;
  on: boolean;
  onSeek(seconds: number): void;
  start: number;
}) {
  return (
    <span
      className={`sheet-mark${mark.carried ? " carried" : ""}${on ? " on" : ""}`}
      style={face.hue === null ? undefined : ({ "--h": face.hue } as CSSProperties)}
      title={mark.carried ? `${face.label} (still ringing)` : `${face.label} at ${start.toFixed(1)} s`}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(start);
      }}
    >
      {face.label}
    </span>
  );
}

type RowProps = {
  row: SheetRow;
  sheet: Sheet;
  faces: readonly Face[];
  state: "past" | "now" | "next";
  /** Last word begun, for the line being sung; -1 elsewhere. */
  word: number;
  /** How far through that word (0..1), when it is still being sung. */
  fill: number | null;
  activeChord: number;
  /** The bar being played, in a row of bars; -1 elsewhere. */
  bar: number;
  onSeek(seconds: number): void;
};

const Row = memo(function Row({ row, sheet, faces, state, word, fill, activeChord, bar, onSeek }: RowProps) {
  const seekRow = () => onSeek(Math.max(0, row.start - 0.1));
  const common = {
    "data-row": row.id,
    className: `sheet-row sheet-${row.kind}-row${row.kind === "chords" && row.bars ? " sheet-bars-row" : ""} is-${state}`,
    tabIndex: 0,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        seekRow();
      }
    },
  };
  const mark = (item: SheetMark, key: string) => (
    <Mark
      key={key}
      mark={item}
      face={faces[item.chord]!}
      on={item.chord === activeChord}
      start={sheet.chords[item.chord]!.start}
      onSeek={onSeek}
    />
  );
  if (row.kind === "chords" && row.bars) {
    return (
      <div {...common} aria-label="Chords only, in bars" onClick={seekRow}>
        {row.bars.map((item, index) => (
          <span
            key={index}
            className={`sheet-bar${index === bar ? " is-now" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(item.start);
            }}
          >
            {item.marks.length ? (
              item.marks.map((m, at) => mark(m, `${index}-${at}`))
            ) : (
              <span className="sheet-bar-rest" aria-label="No chord">
                –
              </span>
            )}
          </span>
        ))}
      </div>
    );
  }
  if (row.kind === "chords") {
    return (
      <div {...common} aria-label="Chords only" onClick={seekRow}>
        {row.marks.map((item, index) => (
          <span key={index} className="sheet-bar">
            {mark(item, "m")}
          </span>
        ))}
      </div>
    );
  }
  return (
    <p {...common} dir={row.rtl ? "rtl" : "ltr"} lang={row.rtl ? "he" : undefined} onClick={seekRow}>
      {row.words.map((item) => {
        const now = item.order === word && fill !== null;
        const sung = state === "past" || item.order < word || (item.order === word && !now);
        return (
          <span
            key={item.order}
            className={`sheet-word${sung && !now ? " sung" : ""}${now ? " now" : ""}`}
            style={now ? ({ "--fill": `${Math.round(fill! * 100)}%` } as CSSProperties) : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(item.start);
            }}
          >
            <span className="sheet-chords" aria-hidden={item.marks.length ? undefined : true}>
              {item.marks.map((m, index) => mark(m, `${index}`))}
            </span>
            <span className="sheet-text">{item.text}</span>
          </span>
        );
      })}
      {row.tail.length > 0 && (
        <span className="sheet-word sheet-tail">
          <span className="sheet-chords">{row.tail.map((m, index) => mark(m, `t${index}`))}</span>
          <span className="sheet-text">{" "}</span>
        </span>
      )}
    </p>
  );
});

/**
 * The song's pulse under the sheet's heading: tempo, meter, the A a guitarist tunes to when the
 * recording is off 440, and a counter that walks the beats of the bar being played.
 */
function RhythmStrip({ rhythm, time, playing }: { rhythm: SheetRhythm; time: number; playing: boolean }) {
  const place = beatPlace(rhythm.beats, rhythm.downbeats, rhythm.meter, time);
  const tuning = tuningNote(rhythm.tuningCents);
  const tempo = rhythm.tempo === null ? null : Math.round(rhythm.tempo);
  return (
    <div className="song-sheet-rhythm">
      {tempo !== null && (
        <span
          className="sheet-fact"
          title={rhythm.steady ? "Beats per minute, read from the whole recording" : "The tempo moves: this is its middle"}
        >
          <strong>{tempo}</strong> BPM{rhythm.steady ? "" : " · tempo moves"}
        </span>
      )}
      {rhythm.meter && (
        <span className="sheet-fact" title="Beats per bar">
          <strong>{rhythm.meter}</strong> beats a bar
        </span>
      )}
      {tuning && (
        <span
          className="sheet-fact is-tuning"
          title={`The recording sits ${Math.abs(tuning.cents)} cents ${tuning.cents < 0 ? "flat" : "sharp"} of A440. Tune to A = ${tuning.hz} Hz to play along in tune.`}
        >
          A = <strong>{tuning.hz}</strong> Hz · {Math.abs(tuning.cents)}¢ {tuning.cents < 0 ? "flat" : "sharp"}
        </span>
      )}
      {rhythm.meter && rhythm.meter >= 2 && (
        <span
          className={`beat-counter${playing ? " is-playing" : ""}`}
          role="img"
          aria-label={place ? `Bar ${place.bar}, beat ${place.beat} of ${place.meter}` : "Before the first beat"}
        >
          <span className="beat-counter-bar">{place ? (place.bar === 0 ? "pickup" : `bar ${place.bar}`) : "—"}</span>
          {Array.from({ length: rhythm.meter }, (_, index) => (
            <i
              // A new key per beat restarts the pulse, so every beat flashes, not just changes.
              key={place && index + 1 === place.beat ? `on-${place.index}` : `off-${index}`}
              className={`${index === 0 ? "is-downbeat " : ""}${place && index + 1 === place.beat ? "is-on" : ""}`}
            />
          ))}
        </span>
      )}
    </div>
  );
}

function sourceLine(map: LyricMap): string {
  if (map.source === "none") return "No singing heard: the sheet is the chords alone.";
  if (map.source === "whisper") {
    return map.note === "lyrics_mismatch"
      ? "The lyrics found online did not match this recording, so these are the words Whisper heard."
      : "No written lyrics found: these are the words Whisper heard.";
  }
  const share = map.wordsTotal ? Math.round((100 * map.wordsHeard) / map.wordsTotal) : 0;
  if (!map.wordsHeard) return "Lyrics from LRCLIB, timed line by line.";
  return `Lyrics from LRCLIB, timed by ear: Whisper heard ${share}% of the words; the rest sit between them.`;
}

export function SongSheet({
  lyrics,
  segments,
  notation,
  keyRoot,
  time,
  playing,
  seekRevision,
  onSeek,
  onRetime,
  rhythm = null,
}: Props) {
  const lines = lyrics.status === "ready" ? lyrics.map.lines : null;
  const grid = useMemo(
    () => (rhythm && rhythm.downbeats.length ? { downbeats: rhythm.downbeats, end: rhythm.duration } : null),
    [rhythm],
  );
  const sheet = useMemo(() => buildSongSheet(lines ?? [], segments, grid), [lines, segments, grid]);
  const faces = useMemo(
    () => sheet.chords.map((chord) => faceOf(segments[chord.segment], notation, keyRoot)),
    [sheet, segments, notation, keyRoot],
  );
  const { changesIn, order } = useMemo(
    () => ({
      // Where each chord change is written. A chord still ringing into later lines only
      // lights up on the line being sung, not on every line it will carry into.
      changesIn: sheet.rows.map((row) => {
        const marks = row.kind === "chords" ? row.marks : [...row.words.flatMap((w) => w.marks), ...row.tail];
        return new Set(marks.filter((m) => !m.carried).map((m) => m.chord));
      }),
      order: new Map(sheet.rows.map((row, index) => [row.id, index])),
    }),
    [sheet],
  );

  const rowIndex = activeIndex(sheet.rows, time + ROW_AHEAD_S);
  const wordIndex = activeIndex(sheet.words, time);
  const current = sheet.words[wordIndex];
  const fill =
    current && time <= current.end + 0.15
      ? Math.min(1, Math.max(0, (time - current.start) / Math.max(0.05, current.end - current.start)))
      : null;
  const chordIndex = activeIndex(sheet.chords, time);
  const activeChord = chordIndex >= 0 && time < sheet.chords[chordIndex]!.end ? chordIndex : -1;
  const nowRow = sheet.rows[rowIndex];
  const activeBar =
    nowRow?.kind === "chords" && nowRow.bars
      ? nowRow.bars.findIndex((item) => time >= item.start && time < item.end)
      : -1;

  const scroller = useRef<HTMLDivElement>(null);
  const raf = useRef<{ id: number | null }>({ id: null });
  const [following, setFollowing] = useState(true);
  const respite = useRef(0);

  useEffect(() => {
    setFollowing(true);
  }, [seekRevision, sheet]);

  useLayoutEffect(() => {
    const root = scroller.current;
    const row = sheet.rows[rowIndex];
    if (!following || !root || !row) return;
    const el = root.querySelector<HTMLElement>(`[data-row="${row.id}"]`);
    if (el) scrollLineToCenter(root, el, 480, raf.current);
  }, [rowIndex, following, sheet]);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const pause = () => {
      setFollowing(false);
      window.clearTimeout(respite.current);
      respite.current = window.setTimeout(() => setFollowing(true), RESPITE_MS);
    };
    root.addEventListener("wheel", pause, { passive: true });
    root.addEventListener("touchmove", pause, { passive: true });
    return () => {
      root.removeEventListener("wheel", pause);
      root.removeEventListener("touchmove", pause);
      window.clearTimeout(respite.current);
      if (raf.current.id != null) cancelAnimationFrame(raf.current.id);
    };
  }, []);

  // Stable, so a clock tick only re-renders the rows whose state moved.
  const seek = useCallback(
    (seconds: number) => {
      window.clearTimeout(respite.current);
      setFollowing(true);
      onSeek(seconds);
    },
    [onSeek],
  );

  return (
    <section className="song-sheet" aria-label="Lyrics and chords">
      <header className="song-sheet-head">
        <div>
          <span className="eyebrow">LYRICS &amp; CHORDS</span>
          <h2>Song sheet</h2>
        </div>
        <div className="song-sheet-actions">
          {!following && playing && (
            <button type="button" className="song-sheet-now" onClick={() => setFollowing(true)}>
              <Crosshair size={14} /> Back to now
            </button>
          )}
          {(lyrics.status === "ready" || lyrics.status === "error") && (
            <button type="button" className="text-button" onClick={onRetime}>
              <RotateCw size={13} /> Time lyrics again
            </button>
          )}
        </div>
      </header>
      {lyrics.status === "mapping" || lyrics.status === "loading" ? (
        <div className="song-sheet-status" role="status">
          <span>
            {lyrics.status === "loading" ? "Opening the lyric timing…" : `${lyricStageLabel(lyrics.stage)}…`}
          </span>
          {lyrics.status === "mapping" && (
            <span className="song-sheet-meter" aria-hidden="true">
              <i style={{ width: `${Math.max(3, Math.min(100, lyrics.progress))}%` }} />
            </span>
          )}
        </div>
      ) : lyrics.status === "error" ? (
        <p className="song-sheet-status is-error" role="alert">
          {lyrics.message} The chords are below on their own.
        </p>
      ) : (
        <p className="song-sheet-source">{sourceLine(lyrics.map)}</p>
      )}
      {rhythm && <RhythmStrip rhythm={rhythm} time={time} playing={playing} />}
      <div className="song-sheet-scroll" ref={scroller}>
        {sheet.sections.map((section) => (
          <section key={section.id} className={`sheet-section is-${section.kind}`}>
            <h3>{section.label}</h3>
            {section.rows.map((row) => {
              const index = order.get(row.id)!;
              const state = index < rowIndex ? "past" : index === rowIndex ? "now" : "next";
              return (
                <Row
                  key={row.id}
                  row={row}
                  sheet={sheet}
                  faces={faces}
                  state={state}
                  word={state === "now" ? wordIndex : -1}
                  fill={state === "now" ? fill : null}
                  activeChord={
                    state === "now" || changesIn[index]!.has(activeChord) ? activeChord : -1
                  }
                  bar={state === "now" ? activeBar : -1}
                  onSeek={seek}
                />
              );
            })}
          </section>
        ))}
        {!sheet.rows.length && <p className="song-sheet-empty">No chords or lyrics to show yet.</p>}
      </div>
    </section>
  );
}
