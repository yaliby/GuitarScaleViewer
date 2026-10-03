import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { SessionController } from "../../harmonia/packages/application/session";
import { NATIVE_MODEL_VERSION } from "../../harmonia/packages/audio/native-whole";
import type { SavedTrack } from "../../harmonia/packages/domain/types";
import { useMediaClock } from "../hooks/useMediaClock";
import { engineLabel, type CapturedTrack } from "../services/trackCapture";
import { analyzedFingerprint, getAnalyzedRevision, subscribeAnalyzed } from "./analyzedCaptures";
import { enqueueChordAnalysis } from "./backgroundChords";
import { getChordJobs, subscribeChordJobs } from "./chordJobs";
import { getHarmoniaSession } from "./composition";
import { latestFor } from "./recordingAnalysis";
import { SongSheet, sheetRhythm } from "./SongSheet";
import { useLyricMap } from "./useLyricMap";

type Props = {
  /** The saved copy of the song the OS is playing, when there is one. */
  track: CapturedTrack | null;
  positionMs: number | null;
  playing: boolean;
};

const EMPTY_LIBRARY: readonly SavedTrack[] = [];

/** Songs already sent back to the recognizer this session, so a failing re-read is not retried. */
const refreshed = new Set<string>();

export function forgetRefreshesForTests(): void {
  refreshed.clear();
}

function subscribeNone() {
  return () => undefined;
}

function noLibrary() {
  return EMPTY_LIBRARY;
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="jam-sheet-status" role="status">
      {children}
    </div>
  );
}

function Sheet({
  track,
  record,
  positionMs,
  playing,
  notice,
}: {
  track: CapturedTrack;
  record: SavedTrack;
  positionMs: number | null;
  playing: boolean;
  notice?: ReactNode;
}) {
  const lyrics = useLyricMap(track.id);
  const clock = useMediaClock(positionMs, playing);
  const rhythm = useMemo(() => sheetRhythm(record.analysis), [record.analysis]);
  return (
    <div className="jam-sheet">
      <p className="jam-sheet-source">
        Read from the saved copy: {[track.artist, track.title].filter(Boolean).join(" — ")} ·{" "}
        {engineLabel(track.engine)}
        {track.engine === "youtube_search"
          ? ". A search match: if another cut of the song is playing, the sheet runs early or late."
          : ""}
      </p>
      {notice}
      <SongSheet
        lyrics={lyrics.state}
        segments={record.analysis.segments}
        notation="advanced"
        keyRoot={record.analysis.key?.root ?? null}
        time={clock.time}
        playing={playing}
        seekRevision={clock.seekRevision}
        onSeek={clock.seek}
        onRetime={lyrics.retime}
        rhythm={rhythm}
      />
    </div>
  );
}

/**
 * Live Jam's song sheet: the chords the recognizer read from the saved copy of the song now
 * playing, over its lyric words as they are sung, on the OS player's clock instead of a player
 * of its own. It is the same analysis the Library opens, so a chord corrected there is
 * corrected here.
 */
export default function LiveSongSheet({ track, positionMs, playing }: Props) {
  const [session, setSession] = useState<SessionController | null>(null);
  const analyzedRevision = useSyncExternalStore(
    subscribeAnalyzed,
    getAnalyzedRevision,
    getAnalyzedRevision,
  );
  const jobs = useSyncExternalStore(subscribeChordJobs, getChordJobs, getChordJobs);
  const library = useSyncExternalStore(
    session ? session.subscribe : subscribeNone,
    session ? () => session.snapshot().library : noLibrary,
  );
  const id = track?.id ?? null;
  const fingerprint = useMemo(() => (id ? analyzedFingerprint(id) : null), [id, analyzedRevision]);
  const record = useMemo(() => latestFor(library, fingerprint), [library, fingerprint]);
  const job = id ? jobs[id] : undefined;
  // Read before bars, tempo and tuning were: read it again, unless somebody corrected it by hand.
  const outdated = Boolean(record && record.analysis.modelVersion !== NATIVE_MODEL_VERSION);
  const corrected = Boolean(record?.corrections.length);

  useEffect(() => {
    if (!track || !outdated || corrected || job || refreshed.has(track.id) || !isTauri()) return;
    refreshed.add(track.id);
    void enqueueChordAnalysis(track, { refresh: true });
  }, [track, outdated, corrected, job]);

  useEffect(() => {
    let live = true;
    void getHarmoniaSession().then(
      (next) => {
        if (live) setSession(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  if (!track) {
    return (
      <Status>
        <strong>No saved copy of this song yet.</strong>
        <span>
          Save it from the deck, or leave auto-save on. Once it is on disk its chords are read and every
          lyric word is timed in the background, and the sheet opens here.
        </span>
      </Status>
    );
  }
  if (job && record) {
    return (
      <Sheet
        track={track}
        record={record}
        positionMs={positionMs}
        playing={playing}
        notice={
          <p className="jam-sheet-refresh" role="status">
            Reading this recording again with the new recognizer (bars, tempo and tuning) ·{" "}
            {Math.max(1, Math.min(99, Math.round(job.progress * 100)))}%
          </p>
        }
      />
    );
  }
  if (job) {
    return (
      <Status>
        <strong>Reading this recording&apos;s chords…</strong>
        <span>{job.stage}</span>
        <span className="jam-sheet-meter" aria-hidden="true">
          <i style={{ width: `${Math.max(3, Math.min(100, Math.round(job.progress * 100)))}%` }} />
        </span>
      </Status>
    );
  }
  if (!fingerprint) {
    return (
      <Status>
        <strong>This recording&apos;s chords have not been read yet.</strong>
        <span>Reading them takes about a minute; the lyric timing follows on its own.</span>
        {isTauri() && (
          <button type="button" className="lab-eng" onClick={() => void enqueueChordAnalysis(track)}>
            Read the chords
          </button>
        )}
      </Status>
    );
  }
  if (!session) {
    return (
      <Status>
        <strong>Opening the analysis…</strong>
      </Status>
    );
  }
  if (!record) {
    return (
      <Status>
        <strong>This recording&apos;s analysis is not in the library any more.</strong>
        <span>Open the song in the Library to read it again.</span>
      </Status>
    );
  }
  return (
    <Sheet
      track={track}
      record={record}
      positionMs={positionMs}
      playing={playing}
      notice={
        outdated && corrected && isTauri() ? (
          <p className="jam-sheet-refresh">
            Read by the older recognizer, and corrected by hand. Read it again for bars, tempo and
            tuning; your corrections stay with the older reading in the Library.{" "}
            <button type="button" className="lab-eng" onClick={() => void enqueueChordAnalysis(track, { refresh: true })}>
              Read again
            </button>
          </p>
        ) : undefined
      }
    />
  );
}
