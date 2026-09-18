import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine, type AudioStep } from "./engine";

export type PlaybackMode = "scale" | "progression" | "metronome";
export function usePracticeAudio(volume: number) {
  const engine = useRef<AudioEngine | null>(null);
  const getEngine = useCallback(
    () => (engine.current ??= new AudioEngine()),
    [],
  );
  const [playing, setPlaying] = useState<PlaybackMode | null>(null);
  const [step, setStep] = useState<{
    notes: number[];
    index: number;
    chordIndex?: number;
  }>({ notes: [], index: -1 });
  const [error, setError] = useState<string | null>(null);
  const stop = useCallback(() => {
    engine.current?.stop();
    setPlaying(null);
    setStep({ notes: [], index: -1 });
  }, []);
  useEffect(() => {
    getEngine().setVolume(volume);
  }, [getEngine, volume]);
  useEffect(() => {
    const ownedEngine = getEngine();
    return () => {
      ownedEngine.dispose();
      if (engine.current === ownedEngine) engine.current = null;
    };
  }, [getEngine]);
  const play = useCallback(
    async (
      mode: PlaybackMode,
      steps: AudioStep[],
      bpm: number,
      loop: boolean,
      click: boolean,
    ) => {
      setError(null);
      setPlaying(mode);
      try {
        await getEngine().start(steps, {
          bpm,
          loop,
          click,
          onStep: (s, index) => setStep({ ...s, index }),
          onEnd: stop,
        });
      } catch {
        stop();
        setError(
          "Audio could not start. Check your output device and try again.",
        );
      }
    },
    [getEngine, stop],
  );
  const audition = useCallback(
    async (notes: number[]) => {
      setError(null);
      try {
        await getEngine().chord(notes);
      } catch {
        setError(
          "Audio is unavailable. Check your output device and try again.",
        );
      }
    },
    [getEngine],
  );
  return { playing, step, error, stop, play, audition };
}
