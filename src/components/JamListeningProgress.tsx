import { AudioLines, RefreshCw } from "lucide-react";
import type { DetectedKeyState } from "../hooks/useDetectedKey";
import type { JamKey } from "../hooks/useLiveJam";
import { musicalLabel } from "./Fretboard";

type Props = {
  detected: DetectedKeyState;
  desktop: boolean;
  playing: boolean;
  settling: boolean;
  locked: boolean;
  following: boolean;
  suggestions: Pick<JamKey, "root" | "scaleType">[];
  onChoose: (root: string, scale: "major" | "minor") => void;
  onManual: () => void;
  onRetry: () => void;
};

export function JamListeningProgress(p: Props) {
  const hasSuggestions = p.suggestions.length > 0;
  const noCapture = p.detected.captureMode === "unavailable";
  const silent = /silence|silent|zero_windows/.test(p.detected.reason ?? "");
  const title = !p.desktop
    ? "Choose a key to start playing."
    : p.locked
      ? "Release the hold to follow music."
      : !p.following
        ? "Choose a key, or turn Follow music on."
        : !p.playing
          ? "Start or resume your song."
          : silent
            ? "No clear music is reaching the analyzer."
            : noCapture
              ? "Audio capture is connecting."
              : p.settling
                ? "A key is settling into place."
                : hasSuggestions
                  ? "We’re comparing possible keys."
                  : "Collecting the first stretch of music.";
  const detail = !p.desktop
    ? "Automatic listening is available in the Windows app. Manual keys and shapes work here."
    : p.settling
      ? "Checking this estimate across fresh stretches of audio before applying it. You can try a key below now; choosing one pauses automatic following."
      : hasSuggestions
      ? "The song information is available, but its key is still an estimate. Try a possibility below to open the fretboard and chords. Choosing one pauses automatic following."
      : silent
        ? "Keep the music player unmuted with audible playback. You can retry listening or choose a key yourself."
        : !p.playing
          ? "Song titles can appear while playback is paused. Start music on this PC to collect audio."
          : "The song title comes from your player. Audio analysis needs enough musical evidence before a scale and chords can appear.";
  return (
    <section className="jam-wait" aria-label="Listening progress">
      <div
        className={`jam-listening-orb ${p.playing && !silent ? "active" : ""}`}
      >
        <AudioLines size={32} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {p.desktop && (
        <span className="jam-candidate">
          {noCapture
            ? "No audio capture yet"
            : `${Math.max(0, p.detected.bufferSeconds).toFixed(0)} seconds of audio collected`}
        </span>
      )}
      {hasSuggestions && (
        <div className="jam-key-suggestions">
          {p.suggestions.map((s) => (
            <button
              className="button accent"
              key={`${s.root}-${s.scaleType}`}
              disabled={p.locked}
              onClick={() => p.onChoose(s.root, s.scaleType)}
            >
              Try {musicalLabel(s.root)} {s.scaleType}
            </button>
          ))}
        </div>
      )}
      <div className="jam-wait-actions">
        <button className="text-button" onClick={p.onManual}>
          Choose a key yourself
        </button>
        {p.desktop && (
          <button className="button subtle" onClick={p.onRetry}>
            <RefreshCw size={13} />
            Retry listening
          </button>
        )}
      </div>
    </section>
  );
}
