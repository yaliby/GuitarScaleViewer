import { memo, useEffect, useRef, useState } from "react";
import { Headphones, Menu, X } from "lucide-react";
import type { FusedKey } from "./services/keyFusion";
import { useMediaSession } from "./hooks/useMediaSession";
import { usePlayAlong } from "./hooks/usePlayAlong";
import { useTrackCapture } from "./hooks/useTrackCapture";
import { TrackCaptureBar } from "./components/TrackCaptureBar";
import { SCALE_TYPE_LABELS, type ScaleType } from "./scaleDataProvider";
import { clockLabel } from "./ui/statusLabels";
import { Led } from "./ui/gear";
import { hasHebrew, scrollLineToCenter } from "./playalong/scroll";
import type { DevSourcePanel, TimedLyricLine } from "./playalong/types";
import "./ui/lab-jam.css";
import "./playalong/playalong.css";

type Props = {
  root: string;
  scaleType: ScaleType;
  fused: FusedKey;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onOpenJam: () => void;
};

const CHART_FIT_CSS = `
body {
  padding: clamp(12px, 3.2vh, 28px) clamp(14px, 3.5vw, 36px) 80px !important;
}
:root {
  --lyric-size: clamp(16px, 2.15vw + 0.4vh, 24px);
  --chord-size: clamp(12px, 1.35vw, 15px);
  --chord-row: clamp(18px, 1.8vw, 22px);
  --line-gap: clamp(10px, 1.5vh, 18px);
}
.chart-head h1 { font-size: clamp(18px, 2vw + 0.4vh, 26px) !important; }
`;

function statusLabel(
  status: string,
  reason: string | null,
  hasTitle: boolean,
  syncHint: string | null,
): string {
  if (syncHint) return syncHint;
  if (status === "loading") return "Looking up lyrics and a chart…";
  if (status === "error")
    return reason || "ChordSync could not resolve this track";
  if (!hasTitle) return "Type a song, or play one on this computer";
  if (status === "chart") return "Chart is following the song";
  if (status === "lyrics") return "Synced lyrics — waiting on a chord page";
  if (status === "plain") return "Lyrics without timing";
  if (status === "none") return reason || "No lyrics or chart for this track";
  return reason || "Ready";
}

export function ChordSyncChart({
  html,
  activeIndex,
  sourceUrl,
}: {
  html: string;
  activeIndex: number | null;
  sourceUrl: string | null;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const paintedRef = useRef<number | null>(null);
  const documentRef = useRef(html);
  if (documentRef.current !== html) {
    documentRef.current = html;
    readyRef.current = false;
    paintedRef.current = null;
  }

  const paint = (index: number | null) => {
    const win = frameRef.current?.contentWindow as
      | (Window & {
          scrollToChartLine?: (next: number) => boolean;
          __csActive?: number;
          __gsvWrap?: boolean;
        })
      | null;
    if (!win || !readyRef.current) return;
    if (index == null) return;
    // ChordChartPanel.set_line_index: never restart the 520ms ease on the same line.
    if (paintedRef.current === index && win.__csActive === index) return;
    try {
      const doc = frameRef.current?.contentDocument;
      if (doc && !doc.getElementById("gsv-fit")) {
        const style = doc.createElement("style");
        style.id = "gsv-fit";
        style.textContent = CHART_FIT_CSS;
        doc.head.appendChild(style);
      }
      // ChordChartPanel.set_line_index: same index must not restart the 520ms ease.
      if (!win.__gsvWrap && win.scrollToChartLine) {
        const orig = win.scrollToChartLine;
        win.scrollToChartLine = (next: number) => {
          if (win.__csActive === next) return true;
          return orig(next);
        };
        win.__gsvWrap = true;
      }
      win.scrollToChartLine?.(index);
      paintedRef.current = index;
    } catch {
      /* chart document not same-origin yet */
    }
  };

  useEffect(() => {
    paint(activeIndex);
  }, [activeIndex, html, sourceUrl]);

  return (
    <iframe
      ref={frameRef}
      className="playalong-chart-frame"
      title="Chord chart"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={html}
      onLoad={() => {
        readyRef.current = true;
        paintedRef.current = null;
        paint(activeIndex);
      }}
    />
  );
}

const ChartFrame = memo(ChordSyncChart);

function NowSinging({
  lines,
  activeIndex,
}: {
  lines: TimedLyricLine[];
  activeIndex: number | null;
}) {
  // TimedLyricsPanel.neighbors: strictly index ± 1. Empty LRC rows stay "—",
  // they are not skipped, so the karaoke strip does not jump two sung lines.
  const current = activeIndex != null ? lines[activeIndex] : undefined;
  const prev =
    activeIndex != null && activeIndex > 0 ? lines[activeIndex - 1] : undefined;
  const next = activeIndex != null ? lines[activeIndex + 1] : undefined;
  const rtl = hasHebrew(current?.text || prev?.text || next?.text);
  return (
    <div
      className="playalong-singing"
      dir={rtl ? "rtl" : "ltr"}
      aria-live="polite"
    >
      <p className="playalong-singing-prev">{prev?.text || "\u00a0"}</p>
      <p className="playalong-singing-current">
        {current?.text || "Waiting for a sung line…"}
      </p>
      <p className="playalong-singing-next">{next?.text || "\u00a0"}</p>
    </div>
  );
}

function LyricsBody({
  lines,
  plain,
  activeIndex,
}: {
  lines: TimedLyricLine[];
  plain: string | null;
  activeIndex: number | null;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const paintedRef = useRef<number | null>(null);
  const rafRef = useRef<{ id: number | null }>({ id: null });
  const linesRef = useRef(lines);
  if (linesRef.current !== lines) {
    linesRef.current = lines;
    paintedRef.current = null;
  }

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !lines.length) return;
    if (paintedRef.current === activeIndex) return;
    paintedRef.current = activeIndex;
    if (activeIndex == null) return;
    const el = root.querySelector<HTMLElement>(`[data-line="${activeIndex}"]`);
    if (!el) return;
    scrollLineToCenter(root, el, 380, rafRef.current);
  }, [activeIndex, lines]);

  useEffect(
    () => () => {
      if (rafRef.current.id != null) {
        cancelAnimationFrame(rafRef.current.id);
        rafRef.current.id = null;
      }
    },
    [],
  );

  if (lines.length) {
    return (
      <div className="playalong-lyrics-scroll" ref={scrollerRef}>
        {lines.map((line) => (
          <p
            key={`${line.index}-${line.timeMs}`}
            data-line={line.index}
            className={line.index === activeIndex ? "is-active" : undefined}
          >
            {line.text || "♪"}
          </p>
        ))}
      </div>
    );
  }
  if (plain) {
    return <pre className="playalong-plain">{plain}</pre>;
  }
  return <p className="playalong-empty">No lyrics yet.</p>;
}

const LyricsList = memo(LyricsBody);
const Singing = memo(NowSinging);

function DevLane({
  title,
  panel,
}: {
  title: string;
  panel: DevSourcePanel | null;
}) {
  const status = panel?.status || "idle";
  const reason = panel?.reason || "Waiting…";
  const extra = [panel?.videoId, panel?.language].filter(Boolean).join(" · ");
  return (
    <section className="playalong-dev-lane" aria-label={title}>
      <header>
        <span className="lab-module-label">{title}</span>
        <small>
          {status}
          {extra ? ` · ${extra}` : ""}
        </small>
      </header>
      {panel?.lines.length ? (
        <LyricsList
          lines={panel.lines}
          plain={null}
          activeIndex={panel.activeIndex}
        />
      ) : (
        <p className="playalong-empty">{reason}</p>
      )}
    </section>
  );
}

function useSplit() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(0.36);
  const [vertical, setVertical] = useState(false);
  const dragRef = useRef(false);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const apply = () => setVertical(node.clientWidth < 860);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current || !stageRef.current) return;
      const box = stageRef.current.getBoundingClientRect();
      if (vertical) {
        const next = (event.clientY - box.top) / Math.max(1, box.height);
        setRatio(Math.min(0.62, Math.max(0.22, next)));
      } else {
        const next = (event.clientX - box.left) / Math.max(1, box.width);
        setRatio(Math.min(0.58, Math.max(0.22, next)));
      }
    };
    const onUp = () => {
      dragRef.current = false;
      document.body.classList.remove("playalong-dragging");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [vertical]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragRef.current = true;
    document.body.classList.add("playalong-dragging");
  };

  return { stageRef, ratio, vertical, onPointerDown };
}

export default function PlayAlongScreen({
  root,
  scaleType,
  menuOpen,
  onToggleMenu,
  onOpenJam,
}: Props) {
  const media = useMediaSession();
  const [devOpen, setDevOpen] = useState(false);
  const playalong = usePlayAlong(media);
  const capture = useTrackCapture(media);
  const split = useSplit();
  const title =
    media.title || playalong.title || playalong.payload?.track?.title;
  const artist =
    media.artist || playalong.artist || playalong.payload?.track?.artist;
  const chart = playalong.payload?.chart ?? null;
  const chartHtml = playalong.payload?.chartHtml ?? null;
  const lines = playalong.singingLines;
  const status = statusLabel(
    playalong.status,
    playalong.reason,
    Boolean(title),
    playalong.syncHint,
  );
  const clock = `${clockLabel(playalong.positionMs)} / ${clockLabel(media.durationMs)}`;

  return (
    <div
      className="lab-shell playalong-shell flex flex-1 flex-col"
      aria-label="Play Along workspace"
      role="region"
    >
      <header className="lab-heading playalong-heading">
        <button
          type="button"
          className="lab-menu"
          aria-label={
            menuOpen ? "Close navigation menu" : "Open navigation menu"
          }
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          {menuOpen ? <X size={16} /> : <Menu size={16} />}
        </button>
        <h1>
          Play <em>along</em>
        </h1>
        <div className="lab-heading-actions">
          <div className="playalong-keychip">
            <span>Key</span>
            <strong data-testid="playalong-key">
              {root} {SCALE_TYPE_LABELS[scaleType]}
            </strong>
          </div>
          <button
            type="button"
            className="lab-eng"
            aria-pressed={devOpen}
            onClick={() => setDevOpen((open) => !open)}
          >
            <Led tone={devOpen ? "data" : "off"} size={5} />
            Dev
          </button>
          <button type="button" className="playalong-jam" onClick={onOpenJam}>
            <Headphones size={15} />
            Live Jam
          </button>
        </div>
      </header>

      <Singing lines={lines} activeIndex={playalong.lyricIndex} />

      <form
        className="playalong-search"
        onSubmit={(event) => {
          event.preventDefault();
          playalong.search();
        }}
      >
        <label>
          Title
          <input
            value={playalong.title}
            onChange={(event) => playalong.setTitle(event.target.value)}
            placeholder="Song title"
            aria-label="Song title"
          />
        </label>
        <label>
          Artist
          <input
            value={playalong.artist}
            onChange={(event) => playalong.setArtist(event.target.value)}
            placeholder="Artist"
            aria-label="Artist"
          />
        </label>
        <button type="submit">Search</button>
        <p
          className="playalong-status-line"
          data-testid="playalong-now-playing"
        >
          <strong>{title || "Nothing playing"}</strong>
          <span>
            {artist ? `${artist} · ` : ""}
            {clock}
            {media.sourceApp ? ` · ${media.sourceApp}` : ""}
            {chart?.source ? ` · ${chart.source}` : ""}
            {" · "}
            {status}
          </span>
        </p>
      </form>
      <TrackCaptureBar capture={capture} compact />

      <div
        className={`playalong-stage${split.vertical ? " is-vertical" : ""}${devOpen ? " has-dev" : ""}`}
        ref={split.stageRef}
        style={
          split.vertical
            ? {
                gridTemplateColumns: "1fr",
                gridTemplateRows: `${split.ratio}fr 10px ${1 - split.ratio}fr`,
              }
            : {
                gridTemplateColumns: `${split.ratio}fr 10px ${1 - split.ratio}fr`,
                gridTemplateRows: "none",
              }
        }
      >
        <section className="playalong-col" aria-label="Synced lyrics">
          <header>
            <span className="lab-module-label">Lyrics</span>
            <small>{playalong.lyricsProvider}</small>
          </header>
          <LyricsList
            lines={lines}
            plain={playalong.payload?.lyrics?.plain ?? null}
            activeIndex={playalong.lyricIndex}
          />
        </section>
        <button
          type="button"
          className="playalong-gutter"
          aria-label="Resize lyrics and chart"
          onPointerDown={split.onPointerDown}
        />
        <section
          className="playalong-col playalong-col-chart"
          aria-label="Chord chart"
        >
          <header>
            <span className="lab-module-label">Chords</span>
            <small>
              {chart?.key ? `key ${chart.key}` : "Tab4U · Ultimate Guitar"}
            </small>
          </header>
          {chartHtml ? (
            <ChartFrame
              html={chartHtml}
              activeIndex={playalong.chartIndex}
              sourceUrl={chart?.sourceUrl ?? null}
            />
          ) : (
            <p className="playalong-empty">
              Waiting for a Tab4U / Ultimate Guitar chart.
            </p>
          )}
        </section>
      </div>
      {devOpen ? (
        <div className="playalong-dev" data-testid="playalong-dev">
          <DevLane title="YouTube CC" panel={playalong.youtube} />
          <DevLane title="Whisper" panel={playalong.whisper} />
        </div>
      ) : null}
    </div>
  );
}
