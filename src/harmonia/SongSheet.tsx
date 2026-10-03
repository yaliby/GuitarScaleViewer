import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Crosshair, Mic, RotateCw } from "lucide-react";
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
  type SheetPiece,
  type SheetRow,
  type SheetSlot,
  type SongSheet as Sheet,
} from "./chordSheet";
import { ChordRunway } from "./ChordRunway";
import { ChordShapes, type ShownChord } from "./ChordShapes";
import type { SingerControl } from "./useSingerLevel";
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
  /** The singer slider, when this song can be separated; omitted where it cannot. */
  singer?: SingerControl | null;
};

const SPLIT_KEY = "gsv.sheet.split";
/** Neither half gets narrower than this share of the width. */
const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.75;
/** A quarter for the shapes, the rest for the sheet. */
const SPLIT_DEFAULT = 0.25;

const clampSplit = (value: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));

function storedSplit(): number {
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    if (value > 0) return clampSplit(value);
  } catch {
    // Storage off: the default share.
  }
  return SPLIT_DEFAULT;
}

/**
 * The shapes on the left, the sheet on the right, and a line between them the player drags to
 * share the width; arrow keys move it too, and a double click puts it back to the default.
 */
function Split({ left, right }: { left: ReactNode; right: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(storedSplit);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_KEY, split.toFixed(3));
    } catch {
      // Not remembered, still applied.
    }
  }, [split]);
  const follow = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect && rect.width > 0) setSplit(clampSplit((clientX - rect.left) / rect.width));
  };
  return (
    <div
      ref={box}
      className={`song-sheet-split${dragging ? " is-dragging" : ""}`}
      style={{ "--split": `${(split * 100).toFixed(1)}%` } as CSSProperties}
    >
      {left}
      <div
        className={`song-sheet-divider${dragging ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Width of the chord shapes and the song sheet"
        aria-valuemin={SPLIT_MIN * 100}
        aria-valuemax={SPLIT_MAX * 100}
        aria-valuenow={Math.round(split * 100)}
        tabIndex={0}
        title="Drag to change the widths · double-click to reset"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (dragging) follow(event.clientX);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setSplit(SPLIT_DEFAULT)}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
          if (!step) return;
          event.preventDefault();
          setSplit((value) => clampSplit(value + step));
        }}
      />
      {right}
    </div>
  );
}

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

/**
 * One stretch of a chord's box. The box is as long as the chord is played; it fills as the song
 * plays through it, so the change comes when it is full.
 */
function Piece({
  piece,
  face,
  on,
  time,
  start,
  onSeek,
}: {
  piece: SheetPiece;
  face: Face | null;
  on: boolean;
  time: number;
  /** When the chord starts, for a click to seek to. */
  start: number;
  onSeek(seconds: number): void;
}) {
  // In milliseconds: grow factors summing under 1 would leave the lane part empty.
  const grow = {
    flexGrow: Math.round((piece.end - piece.start) * 1000),
    "--dur": (piece.end - piece.start).toFixed(2),
  } as CSSProperties;
  if (!face) return <span className="sheet-piece is-rest" style={grow} />;
  const phase = time >= piece.end ? "played" : time >= piece.start ? "playing" : "ahead";
  const fill = phase === "playing" ? (time - piece.start) / (piece.end - piece.start) : null;
  return (
    <span
      className={
        `sheet-piece is-${phase}${on ? " on" : ""}${piece.label ? "" : " is-bare"}` +
        `${piece.opens ? " opens" : ""}${piece.closes ? " closes" : ""}`
      }
      style={
        {
          ...grow,
          ...(face.hue === null ? {} : { "--h": face.hue }),
          ...(fill === null ? {} : { "--fill": `${(fill * 100).toFixed(1)}%` }),
        } as CSSProperties
      }
      title={`${face.label} at ${start.toFixed(1)} s`}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(start);
      }}
    >
      {piece.label && <span className={`sheet-piece-name${piece.opens ? "" : " carried"}`}>{face.label}</span>}
    </span>
  );
}

/**
 * The chord names over a word, written where the chord changes, as on a printed sheet: a box per
 * change that stands still. The one being played lights and fills as it is played, the next one
 * is marked, the ones played dim; the runway above the sheet shows when the change comes.
 * `crowded`: the next word has names of its own, so these take their width in the line;
 * otherwise they run on over the next word's empty chord line.
 */
function Marks({
  marks,
  faces,
  sheet,
  activeChord,
  progress,
  nextChord,
  crowded,
  onSeek,
}: {
  marks: readonly SheetMark[];
  faces: readonly Face[];
  sheet: Sheet;
  activeChord: number;
  progress: number | null;
  nextChord: number;
  crowded: boolean;
  onSeek(seconds: number): void;
}) {
  return (
    <span className={`sheet-chords${crowded ? " is-crowded" : ""}`}>
      {marks.map((mark) => {
        const face = faces[mark.chord]!;
        if (!face.label) return null;
        const start = sheet.chords[mark.chord]!.start;
        const on = mark.chord === activeChord;
        const next = !on && !mark.carried && mark.chord === nextChord;
        const phase = on ? " on" : next ? " is-next" : activeChord >= 0 && mark.chord < activeChord ? " is-played" : "";
        const style = {
          ...(face.hue === null ? {} : { "--h": face.hue }),
          ...(on && progress !== null ? { "--fill": `${(progress * 100).toFixed(1)}%` } : {}),
        } as CSSProperties;
        return (
          <span
            key={`${mark.chord}${mark.carried ? "c" : ""}`}
            className={`sheet-chord${mark.carried ? " carried" : ""}${phase}`}
            style={style}
            title={`${face.label} at ${start.toFixed(1)} s`}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(start);
            }}
          >
            {face.label}
          </span>
        );
      })}
    </span>
  );
}

/** A slot's length on the clock, so a long rest or chord is drawn longer than a quick one. */
function seconds(slot: SheetSlot): CSSProperties {
  return { "--slot": Math.max(0, slot.end - slot.start).toFixed(2) } as CSSProperties;
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
  /** How far through the chord being played (0..1), in the line being sung; null elsewhere. */
  progress: number | null;
  /** The next chord, for the line being sung and the one after it (its first chord may be it); -1 elsewhere. */
  nextChord: number;
  /** The clock, while it is inside this row's lane; ±Infinity once past it or before it. */
  time: number;
  /** The bar being played, in a row of bars; -1 elsewhere. */
  bar: number;
  onSeek(seconds: number): void;
};

const Row = memo(function Row({ row, sheet, faces, state, word, fill, activeChord, progress, nextChord, time, bar, onSeek }: RowProps) {
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
  const lane = (pieces: readonly SheetPiece[]) => (
    <span className="sheet-lane">
      {pieces.map((piece, index) => (
        <Piece
          key={index}
          piece={piece}
          face={piece.chord >= 0 ? faces[piece.chord]! : null}
          on={piece.chord === activeChord}
          time={time}
          start={piece.chord >= 0 ? sheet.chords[piece.chord]!.start : piece.start}
          onSeek={onSeek}
        />
      ))}
    </span>
  );
  const marks = (items: readonly SheetMark[], crowded: boolean) => (
    <Marks
      marks={items}
      faces={faces}
      sheet={sheet}
      activeChord={activeChord}
      progress={progress}
      nextChord={nextChord}
      crowded={crowded}
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
            {item.pieces.some((piece) => piece.chord >= 0) ? (
              lane(item.pieces)
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
        {row.slots.map((slot, index) => (
          <span key={index} className="sheet-bar" style={seconds(slot)}>
            {lane(slot.pieces)}
          </span>
        ))}
      </div>
    );
  }
  return (
    <p {...common} dir={row.rtl ? "rtl" : "ltr"} lang={row.rtl ? "he" : undefined} onClick={seekRow}>
      {row.words.map((item, at) => {
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
            {marks(item.marks, item.marks.length > 0 && (row.words[at + 1]?.marks ?? row.tail).length > 0)}
            <span className="sheet-text">{item.text}</span>
          </span>
        );
      })}
      {row.tail.length > 0 && (
        <span className="sheet-word sheet-tail">
          {marks(row.tail, true)}
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
  if (!map.wordsHeard) {
    const why =
      map.ear === "missing"
        ? "Whisper is not installed, so nobody listened for the words"
        : map.ear === "failed"
          ? "Whisper could not listen to this recording"
          : "Whisper heard none of the words";
    return `Lyrics from LRCLIB, timed line by line from the site's clock: ${why}, and a line may run early or late against the singer.`;
  }
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
  singer = null,
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
  const order = useMemo(() => new Map(sheet.rows.map((row, index) => [row.id, index])), [sheet]);

  const rowIndex = activeIndex(sheet.rows, time + ROW_AHEAD_S);
  const wordIndex = activeIndex(sheet.words, time);
  const current = sheet.words[wordIndex];
  const fill =
    current && time <= current.end + 0.15
      ? Math.min(1, Math.max(0, (time - current.start) / Math.max(0.05, current.end - current.start)))
      : null;
  const chordIndex = activeIndex(sheet.chords, time);
  const activeChord = chordIndex >= 0 && time < sheet.chords[chordIndex]!.end ? chordIndex : -1;
  const playedChord = sheet.chords[activeChord];
  const progress = playedChord
    ? Math.min(1, Math.max(0, (time - playedChord.start) / Math.max(0.05, playedChord.end - playedChord.start)))
    : null;
  // The chord being played, or the one coming when none is: the panel beside the sheet shows it.
  const shownChord = activeChord >= 0 ? activeChord : chordIndex + 1;
  const shown = useMemo((): [ShownChord | null, ShownChord | null] => {
    const at = (index: number): ShownChord | null => {
      const segment = sheet.chords[index] && segments[sheet.chords[index]!.segment];
      return segment ? { chord: segment.chord, label: faces[index]!.label, hue: faces[index]!.hue } : null;
    };
    return [at(shownChord), at(shownChord + 1)];
  }, [sheet, segments, faces, shownChord]);
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
    <Split
      left={<ChordShapes now={shown[0]} next={shown[1]} upcoming={activeChord < 0} />}
      right={
        <section className="song-sheet" aria-label="Lyrics and chords">
          <header className="song-sheet-head">
            <div>
              <span className="eyebrow">LYRICS &amp; CHORDS</span>
              <h2>Song sheet</h2>
            </div>
            <div className="song-sheet-actions">
              {singer && (
                <label className="song-sheet-singer" title="Turn the singer down to sing along">
                  <Mic size={14} aria-hidden="true" />
                  <span>Singer</span>
                  <input
                    type="range"
                    aria-label="Singer volume"
                    min="0"
                    max="1"
                    step="0.05"
                    value={singer.level}
                    onChange={(event) => singer.onChange(Number(event.target.value))}
                  />
                  <output>{Math.round(singer.level * 100)}%</output>
                </label>
              )}
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
          {singer?.preparing && (
            <div className="song-sheet-status" role="status">
              <span>Separating the singer from the band — once per song…</span>
              <span className="song-sheet-meter" aria-hidden="true">
                <i style={{ width: `${Math.max(3, Math.min(100, singer.preparing.progress))}%` }} />
              </span>
            </div>
          )}
          {singer?.error && (
            <p className="song-sheet-status is-error" role="alert">
              {singer.error}
            </p>
          )}
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
          {sheet.chords.length > 0 && (
            <ChordRunway
              chords={sheet.chords}
              faces={faces}
              beats={rhythm?.beats ?? []}
              downbeats={rhythm?.downbeats ?? []}
              time={time}
              onSeek={seek}
            />
          )}
          <div className="song-sheet-scroll" ref={scroller}>
            {sheet.sections.map((section) => (
              <section key={section.id} className={`sheet-section is-${section.kind}`}>
                <h3>{section.label}</h3>
                {section.rows.map((row) => {
                  const index = order.get(row.id)!;
                  const state = index < rowIndex ? "past" : index === rowIndex ? "now" : "next";
                  // Only the row the clock is in follows it; the rest are played through or ahead,
                  // so a tick re-renders just that row. A line of lyrics lights its chords only while
                  // it is the line being sung, so they turn with the words, never in the line before.
                  const lyric = row.kind === "lyric";
                  const inside = !lyric && time >= row.lane.start && time < row.lane.end;
                  return (
                    <Row
                      key={row.id}
                      row={row}
                      sheet={sheet}
                      faces={faces}
                      state={state}
                      word={state === "now" ? wordIndex : -1}
                      fill={state === "now" ? fill : null}
                      activeChord={inside || state === "now" ? activeChord : -1}
                      progress={state === "now" ? progress : null}
                      nextChord={state === "now" || index === rowIndex + 1 ? chordIndex + 1 : -1}
                      time={inside ? time : lyric || time < row.lane.end ? -Infinity : Infinity}
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
      }
    />
  );
}
