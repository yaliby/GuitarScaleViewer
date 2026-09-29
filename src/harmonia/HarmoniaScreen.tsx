import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Menu, Music2, X } from "lucide-react";
import type { CatalogRecording } from "../../harmonia/packages/application/catalog-contracts";
import type { SessionController } from "../../harmonia/packages/application/session";
import { ConsumerPlayer } from "../../harmonia/apps/desktop/src/components/ConsumerPlayer";
import { AnalysisProgress } from "../../harmonia/apps/desktop/src/components/SessionStatus";
import { TrackCaptureBar } from "../components/TrackCaptureBar";
import { useMediaSession } from "../hooks/useMediaSession";
import { useTrackCapture } from "../hooks/useTrackCapture";
import { getLyricJobs, lyricStageLabel, subscribeLyricJobs } from "../services/lyricMap";
import {
  listTrackCaptures,
  loadCapturedFile,
  type CapturedTrack,
} from "../services/trackCapture";
import "../../harmonia/apps/desktop/src/styles/tokens.css";
import "../../harmonia/apps/desktop/src/styles/app.css";
import "../ui/lab-jam.css";
import { analyzedCaptureIds, analyzedFingerprint, getAnalyzedRevision, markCaptureAnalyzed, subscribeAnalyzed } from "./analyzedCaptures";
import { cancelChordAnalysis } from "./backgroundChords";
import { getChordJobs, subscribeChordJobs } from "./chordJobs";
import {
  getHarmoniaSession,
  pauseHarmoniaPlayback,
  prepareCapturedSong,
} from "./composition";
import { SongSheet } from "./SongSheet";
import { useLyricMap } from "./useLyricMap";
import "./HarmoniaScreen.css";

type Props = {
  menuOpen: boolean;
  onToggleMenu: () => void;
};

function asRecording(track: CapturedTrack): CatalogRecording {
  return {
    id: track.id,
    provider: "studio",
    title: track.title,
    artist: track.artist ?? "",
    duration: track.durationMs ? track.durationMs / 1000 : null,
    thumbnail: track.artworkUrl,
    pageUrl: track.webpageUrl ?? "",
    canPrepare: true,
    audio: null,
  };
}

function durationLabel(ms: number | null): string {
  if (!ms || ms < 1000) return "";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const idleSnapshot = {
  status: "idle" as const,
  stage: "",
  progress: 0,
  current: null,
  library: [],
  error: null,
  profile: "balanced" as const,
  saveState: "saved" as const,
};

function subscribeIdle() {
  return () => undefined;
}

function snapshotIdle() {
  return idleSnapshot;
}

export default function HarmoniaScreen({ menuOpen, onToggleMenu }: Props) {
  const media = useMediaSession();
  const capture = useTrackCapture(media);
  const [session, setSession] = useState<SessionController | null>(null);
  const [tracks, setTracks] = useState<CapturedTrack[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const opener = useRef(0);
  const analyzedRevision = useSyncExternalStore(
    subscribeAnalyzed,
    getAnalyzedRevision,
    getAnalyzedRevision,
  );
  const analyzed = useMemo(() => analyzedCaptureIds(), [analyzedRevision]);
  const chordJobs = useSyncExternalStore(subscribeChordJobs, getChordJobs, getChordJobs);
  const lyricJobs = useSyncExternalStore(subscribeLyricJobs, getLyricJobs, getLyricJobs);
  const analysis = useSyncExternalStore(
    session ? session.subscribe : subscribeIdle,
    session ? session.snapshot : snapshotIdle,
  );

  useEffect(() => {
    let cancelled = false;
    void getHarmoniaSession().then((next) => {
      if (!cancelled) setSession(next);
    });
    return () => {
      cancelled = true;
      pauseHarmoniaPlayback();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await listTrackCaptures();
      if (cancelled) return;
      if (result.status === "error") {
        setListError(result.message || result.reason || "Could not read saved songs.");
        return;
      }
      setListError(null);
      setTracks(result.tracks ?? []);
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [capture.status, capture.track?.id]);

  const selected = useMemo(
    () => tracks.find((track) => track.id === openId) ?? null,
    [tracks, openId],
  );
  const busy =
    analysis.status === "preparing" || analysis.status === "analyzing";
  const current = analysis.status === "ready" ? analysis.current : null;
  const playerOpen =
    current !== null &&
    selected !== null &&
    openingId === null &&
    current.track.fingerprint === analyzedFingerprint(selected.id);
  const lyrics = useLyricMap(playerOpen ? selected.id : null);
  const openingJob = openingId ? chordJobs[openingId] : undefined;
  const stopOpening = () => {
    opener.current += 1;
    if (openingId) cancelChordAnalysis(openingId);
    session?.cancel();
    setOpeningId(null);
    setOpenId(null);
  };

  const openTrack = async (track: CapturedTrack, force = false) => {
    if (!session) return;
    const token = ++opener.current;
    if (capture.playing) capture.togglePlayback();
    setOpenId(track.id);
    setOpeningId(track.id);
    try {
      const file = await loadCapturedFile(track);
      if (token !== opener.current) return;
      await prepareCapturedSong(file, force, () => token !== opener.current);
      if (token !== opener.current) return;
      const ready = session.snapshot();
      if (ready.current) {
        markCaptureAnalyzed(track.id, ready.current.track.fingerprint);
      }
    } catch (error) {
      if (token !== opener.current) return;
      setListError(
        error instanceof Error ? error.message : "Could not open this song.",
      );
    } finally {
      if (token === opener.current) setOpeningId(null);
    }
  };

  const backToLibrary = () => {
    opener.current += 1;
    session?.player.pause();
    session?.cancel();
    setOpeningId(null);
    setOpenId(null);
  };

  return (
    <div
      className="lab-screen harmonia-root harmonia-embed"
      role="region"
      aria-label="Library workspace"
    >
      <header className="lab-heading">
        <button
          type="button"
          className="lab-menu"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-controls="studio-sidebar"
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <h1>
          Song <em>library</em>
        </h1>
        <div className="lab-heading-actions">
          <span className="lab-status">
            {tracks.length} saved
          </span>
        </div>
      </header>

      <div className="harmonia-stage">
        {(listError || analysis.error) && (
          <div role="alert" className="error-banner">
            {listError ?? analysis.error}
          </div>
        )}

        {playerOpen ? (
          <>
            <button type="button" className="harmonia-back" onClick={backToLibrary}>
              <ArrowLeft size={16} />
              Back to saved songs
            </button>
            <ConsumerPlayer
              key={current.analysis.id}
              record={current}
              controller={session!}
              recording={asRecording(selected)}
              onReanalyze={() => void openTrack(selected, true)}
              sheet={(slot) => (
                <SongSheet
                  lyrics={lyrics.state}
                  segments={slot.segments}
                  notation={slot.notation}
                  keyRoot={slot.keyRoot}
                  time={slot.time}
                  playing={slot.playing}
                  seekRevision={slot.seekRevision}
                  onSeek={slot.seek}
                  onRetime={lyrics.retime}
                />
              )}
            />
          </>
        ) : busy || openingId !== null ? (
          <AnalysisProgress
            stage={(busy && analysis.stage) || openingJob?.stage || "Preparing the song"}
            progress={busy ? analysis.progress : (openingJob?.progress ?? 0)}
            onCancel={stopOpening}
          />
        ) : (
          <div className="harmonia-library">
            <div className="harmonia-library-copy">
              <h2>Songs this app has saved</h2>
              <p>
                Capture a track from Live Jam or Explore. As soon as the
                download finishes, its chords are read and every lyric word is
                timed in the background, so the song opens ready with a chord
                sheet that follows it — here, or under the neck in Live Jam.
              </p>
            </div>
            <TrackCaptureBar capture={capture} compact />
            {tracks.length === 0 ? (
              <p className="harmonia-empty">
                Nothing saved yet. Paste a YouTube link above, or turn on
                auto-save while a song is playing.
              </p>
            ) : (
              <div className="harmonia-library-list">
                {tracks.map((track) => {
                  const ready = analyzed.has(track.id);
                  const job = chordJobs[track.id];
                  const lyricJob = lyricJobs[track.id];
                  return (
                    <button
                      key={track.id}
                      type="button"
                      className="harmonia-song"
                      disabled={!session}
                      onClick={() => void openTrack(track)}
                      aria-label={`Open ${track.title}`}
                    >
                      {track.artworkUrl ? (
                        <img src={track.artworkUrl} alt="" />
                      ) : (
                        <span className="harmonia-song-art">
                          <Music2 size={22} />
                        </span>
                      )}
                      <span>
                        <strong>{track.title}</strong>
                        <small>
                          {[track.artist, durationLabel(track.durationMs)]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      <span
                        className="harmonia-song-state"
                        title={job?.stage ?? (lyricJob ? lyricStageLabel(lyricJob.stage) : undefined)}
                      >
                        {job ? "Chords…" : lyricJob ? "Lyrics…" : ready ? "Ready" : "Analyze"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
