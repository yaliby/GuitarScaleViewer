import { useState } from "react";
import {
  AudioLines,
  ChevronDown,
  LockKeyhole,
  LockKeyholeOpen,
  Radio,
  RefreshCw,
  ArrowUpRight,
  Cloud,
  Check,
} from "lucide-react";
import type { DetectedKeyState } from "../hooks/useDetectedKey";
import type { MediaSessionUiState } from "../hooks/useMediaSession";
import type { useCloudKeyResolution } from "../hooks/useCloudKeyResolution";
import { musicalLabel } from "./Fretboard";

type Props = {
  media: MediaSessionUiState;
  detected: DetectedKeyState;
  cloud: ReturnType<typeof useCloudKeyResolution>;
  locked: boolean;
  auto: boolean;
  onLock: () => void;
  onAuto: (v: boolean) => void;
  onApply: () => void;
  canApply: boolean;
  onRetry: () => void;
  root: string;
  scale: string;
};
export function ListeningPanel({
  media,
  detected,
  cloud,
  locked,
  auto,
  onLock,
  onAuto,
  onApply,
  canApply,
  onRetry,
  root,
  scale,
}: Props) {
  const [details, setDetails] = useState(false);
  const desktop = media.playbackStatus !== "media_session_unavailable";
  const name = cloud.cloudHit?.displayName ?? detected.displayName;
  const ready =
    !!cloud.cloudHit || (detected.readyToApply && !detected.ambiguous);
  const status = !desktop
    ? "Desktop listening"
    : media.playbackStatus === "paused"
      ? "Playback paused"
      : name
        ? ready
          ? "Key is ready"
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
            : cloud.cloudHit
              ? "Found in the verified song library."
              : name
                ? ready
                  ? "Stable audio evidence. Apply it to explore this key."
                  : "Still a suggestion. Listen to the alternatives before applying."
                : "Start music in your player. You can always choose a key yourself."}
        </p>
      </div>
      {detected.alternatives.length > 0 && !cloud.cloudHit && (
        <div className="alternatives">
          Also possible:{" "}
          {detected.alternatives
            .slice(0, 2)
            .map((a) => musicalLabel(a.displayName))
            .join(" · ")}
        </div>
      )}
      <div className="listening-actions">
        <button
          className="button accent"
          disabled={!canApply || locked}
          onClick={onApply}
        >
          {ready ? "Use this key" : "Try suggestion"}
          <ArrowUpRight size={14} />
        </button>
        <button
          className={`icon-button ${locked ? "is-active" : ""}`}
          onClick={onLock}
          aria-label={locked ? "Unlock practice key" : "Lock practice key"}
          aria-pressed={locked}
        >
          {locked ? <LockKeyhole size={16} /> : <LockKeyholeOpen size={16} />}
        </button>
      </div>
      {locked && (
        <p className="lock-description">
          Holding {musicalLabel(root)} {scale}. Unlock to follow another key.
        </p>
      )}
      <label className="switch-row">
        <span>
          Auto follow <small>Stable keys only</small>
        </span>
        <input
          aria-label="Auto follow stable keys"
          type="checkbox"
          checked={auto}
          onChange={(e) => onAuto(e.target.checked)}
          disabled={!desktop}
        />
        <span className="switch-track" />
      </label>
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
            <dd>{cloud.cloudHit ? "Cloud library" : detected.source}</dd>
            <dt>Analysis</dt>
            <dd>{detected.state.replaceAll("_", " ")}</dd>
            <dt>Evidence score</dt>
            <dd>
              {Math.round(detected.confidence * 100)}% · not an accuracy
              guarantee
            </dd>
            <dt>Audio collected</dt>
            <dd>{detected.bufferSeconds.toFixed(1)} seconds</dd>
            <dt>Connection</dt>
            <dd>{cloud.cloudState}</dd>
          </dl>
          {detected.reason && <p>{detected.reason.replaceAll("_", " ")}</p>}
          {cloud.cloudError && <p>{cloud.cloudError}</p>}
          <button
            className="button subtle"
            onClick={onRetry}
            disabled={!desktop}
          >
            <RefreshCw size={13} />
            Retry audio analysis
          </button>
          {media.title &&
            media.artist &&
            (scale === "major" || scale === "minor") && (
              <button
                className="button subtle"
                onClick={() => void cloud.submitSuggestion(root, scale)}
                disabled={
                  cloud.suggestionStatus === "submitting" ||
                  cloud.suggestionStatus === "success"
                }
              >
                {cloud.suggestionStatus === "success" ? (
                  <Check size={13} />
                ) : (
                  <Cloud size={13} />
                )}
                Suggest current key
              </button>
            )}
          {cloud.suggestionMessage && (
            <p role="status">{cloud.suggestionMessage}</p>
          )}
        </div>
      )}
    </section>
  );
}
