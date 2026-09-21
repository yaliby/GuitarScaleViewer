import { useState } from "react";
import {
  AudioLines,
  ChevronDown,
  Radio,
  RefreshCw,
  Zap,
  ZapOff,
} from "lucide-react";
import type { DetectedKeyState } from "../hooks/useDetectedKey";
import type { MediaSessionUiState } from "../hooks/useMediaSession";
import type { useCloudKeyResolution } from "../hooks/useCloudKeyResolution";
import type { FusedKey } from "../services/keyFusion";
import { musicalLabel } from "./Fretboard";

type Props = {
  media: MediaSessionUiState;
  detected: DetectedKeyState;
  cloud: ReturnType<typeof useCloudKeyResolution>;
  /**
   * The pipeline's single decision — the same object Live Jam draws from. Explore used to
   * re-derive its own verdict from `detected` + `cloud`, which let the two screens disagree
   * about the same song and left this panel telling the player to "apply" a key with a button
   * that no longer exists.
   */
  fused: FusedKey;
  /** Is the neck allowed to take the pipeline's key? On by default; off freezes what is drawn. */
  applyDetected: boolean;
  onToggleApply: () => void;
  onRetry: () => void;
  root: string;
  scale: string;
};
export function ListeningPanel({
  media,
  detected,
  cloud,
  fused,
  applyDetected,
  onToggleApply,
  onRetry,
  root,
  scale,
}: Props) {
  const [details, setDetails] = useState(false);
  const desktop = media.playbackStatus !== "media_session_unavailable";
  const name = fused.displayName ?? cloud.cloudHit?.displayName ?? detected.displayName;
  // The one case worth its own wording: the notes are right and only the root is open.
  const tonicOpen = !fused.tonicSettled && !!fused.relativeAlternative;
  const status = !desktop
    ? "Desktop listening"
    : media.playbackStatus === "paused"
      ? "Playback paused"
      : name
        ? fused.certainty === "verified"
          ? "Key is ready"
          : tonicOpen
            ? "Notes sure, root open"
            : "Possible key"
        : media.playbackStatus === "playing"
          ? "Listening to your music"
          : "Ready when you are";
  return (
    <section className="listening-panel panel" aria-label="Song key detection">
      <div className="panel-heading">
        <div className="heading-with-icon">
          <Radio size={17} />
          <h2>Play along</h2>
        </div>
        <span
          className={`status-dot ${media.playbackStatus === "playing" ? "live" : ""}`}
        />
      </div>
      <div className="track-display">
        <div className="track-art">
          <AudioLines size={23} />
        </div>
        <div>
          <strong>{media.title || "Your next jam starts here"}</strong>
          <span>{media.artist || "Play a song. Find your way around it."}</span>
        </div>
      </div>
      <div className="listening-key">
        <span className="eyebrow">{status}</span>
        <strong>{name ? musicalLabel(name) : "Let the music lead."}</strong>
        <p>
          {!desktop
            ? "Open the desktop app to identify the key of music playing on your computer. All practice tools work here."
            : fused.certainty === "verified"
              ? "Found in the verified song library."
              : name
                ? !applyDetected
                  ? "Apply is off, so the neck is staying where it is. Switch Apply on to take this key."
                  : tonicOpen
                    ? `The scale tones are settled — this reads equally as ${musicalLabel(fused.relativeAlternative!)}, which draws the same notes.`
                    : "The neck is already following this. Nothing to press."
                : "Start music in your player. You can always choose a key yourself."}
        </p>
      </div>
      {tonicOpen ? (
        <div className="alternatives" data-testid="explore-key-alt">
          Same notes as: {musicalLabel(fused.relativeAlternative!)}
        </div>
      ) : detected.alternatives.length > 0 && fused.certainty !== "verified" ? (
        <div className="alternatives">
          Also possible:{" "}
          {detected.alternatives
            .slice(0, 2)
            .map((a) => musicalLabel(a.displayName))
            .join(" · ")}
        </div>
      ) : null}
      <div className="listening-actions">
        <button
          className={`icon-button apply-toggle ${applyDetected ? "is-active" : ""}`}
          onClick={onToggleApply}
          aria-label={applyDetected ? "Turn off Apply" : "Turn on Apply"}
          aria-pressed={applyDetected}
          title={
            applyDetected
              ? "Apply is on: the neck follows the song. Switch it off to keep this key."
              : "Apply is off: the neck holds this key. Switch it on to take the key being heard."
          }
        >
          {applyDetected ? <Zap size={16} /> : <ZapOff size={16} />}
          Apply
        </button>
      </div>
      {!applyDetected && (
        <p className="lock-description">
          Holding {musicalLabel(root)} {scale}. Turn Apply back on to follow the song again.
        </p>
      )}
      <button
        className="details-toggle"
        aria-expanded={details}
        onClick={() => setDetails((v) => !v)}
      >
        Connection & diagnostics
        <ChevronDown size={13} className={details ? "rotated" : ""} />
      </button>
      {details && (
        <div className="diagnostics">
          <dl>
            <dt>Source</dt>
            <dd>{cloud.cloudHit ? "Verified library" : detected.source}</dd>
            <dt>Analysis</dt>
            <dd>{detected.state.replaceAll("_", " ")}</dd>
            <dt>Evidence score</dt>
            <dd>
              {Math.round(detected.confidence * 100)}% · not an accuracy
              guarantee
            </dd>
            <dt>Audio collected</dt>
            <dd>{detected.bufferSeconds.toFixed(1)} seconds</dd>
            <dt>Library</dt>
            <dd>{cloud.cloudState}</dd>
          </dl>
          {detected.reason && <p>{detected.reason.replaceAll("_", " ")}</p>}
          <button
            className="button subtle"
            onClick={onRetry}
            disabled={!desktop}
          >
            <RefreshCw size={13} />
            Retry audio analysis
          </button>
        </div>
      )}
    </section>
  );
}
