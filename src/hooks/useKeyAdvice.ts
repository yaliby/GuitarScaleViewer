import { useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis } from '../../harmonia/packages/domain/types';
import { trace } from '../services/debugLog';
import { chartAdvice, combineAdvice, recordingAdvice, type KeyAdvice } from '../services/keyAdvice';
import type { CaptureEngine, CapturedTrack } from '../services/trackCapture';
import type { MediaSessionUiState } from './useMediaSession';
import { usePlayAlongChart } from './usePlayAlong';
import { captureMediaKey } from './useTrackCapture';

/** A copy saved from what is playing is the recording; a search match may be another cut of it. */
function isSameRecording(engine: CaptureEngine): boolean {
  return engine !== 'youtube_search';
}

/** The play-along store keeps the session's title and artist trimmed and otherwise verbatim. */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

/**
 * What the chords say about the song playing now, for `fuseKey`'s `advice`.
 *
 * Two legs, each only when it is about *this* song: the chart the play-along scraped for the media
 * session's title and artist, and the chords the recogniser read off the saved copy the capture store
 * found for this same session. Either can be a leftover of the last song for a moment after a track
 * change — both stores resolve asynchronously — and a leftover would put the old song's key on the new
 * one with a chart's authority, so each is checked against the session before it is read.
 */
export function useKeyAdvice(
  media: MediaSessionUiState,
  capture: { track: CapturedTrack | null; trackFor?: string | null },
  trackIdentity: string | null,
): KeyAdvice | null {
  const playAlong = usePlayAlongChart();
  const chart =
    playAlong.chart && sameName(playAlong.title, media.title) && sameName(playAlong.artist, media.artist)
      ? playAlong.chart
      : null;
  const chartLeg = useMemo(() => (trackIdentity ? chartAdvice(chart, trackIdentity) : null), [chart, trackIdentity]);

  const saved = capture.track && capture.trackFor === captureMediaKey(media) ? capture.track : null;
  const savedId = saved?.id ?? null;
  const [read, setRead] = useState<{ id: string; analysis: Analysis } | null>(null);
  useEffect(() => {
    setRead(null);
    if (!savedId) return;
    let live = true;
    let unwatch: (() => void) | null = null;
    // The analysis stack loads only for a song that has a saved copy, as it does for the sheet.
    void import('../harmonia/recordingAnalysis').then(
      ({ watchRecordingAnalysis }) => {
        if (!live) return;
        unwatch = watchRecordingAnalysis(savedId, (analysis) => {
          if (live) setRead(analysis ? { id: savedId, analysis } : null);
        });
      },
      () => undefined,
    );
    return () => {
      live = false;
      unwatch?.();
    };
  }, [savedId]);
  const engine = saved?.engine ?? null;
  const recordingLeg = useMemo(
    () =>
      read && engine && read.id === savedId && trackIdentity
        ? recordingAdvice(read.analysis, isSameRecording(engine), trackIdentity)
        : null,
    [engine, read, savedId, trackIdentity],
  );

  const advice = useMemo(() => combineAdvice(recordingLeg, chartLeg), [chartLeg, recordingLeg]);

  const logged = useRef('');
  useEffect(() => {
    const sig = advice
      ? `${advice.trackIdentity}:${advice.key}:${advice.mode}:${advice.sources.join('+')}:${advice.noteSetP.toFixed(2)}`
      : `none:${trackIdentity}`;
    if (logged.current === sig) return;
    logged.current = sig;
    if (!advice) return;
    trace(
      'advice',
      'advice.update',
      `The ${advice.sources.join(' and ')} ${advice.sources.length > 1 ? 'read' : 'reads'} ${advice.key} ${advice.mode} (p=${advice.noteSetP.toFixed(2)})`,
      {
        key: advice.key,
        mode: advice.mode,
        noteSetP: advice.noteSetP,
        tonicShare: advice.tonicShare,
        sources: advice.sources,
        chart: chartLeg ? `${chartLeg.key} ${chartLeg.mode} p=${chartLeg.noteSetP.toFixed(2)} ${chartLeg.why}` : null,
        recording: recordingLeg
          ? `${recordingLeg.key} ${recordingLeg.mode} p=${recordingLeg.noteSetP.toFixed(2)} ${recordingLeg.why}`
          : null,
        trackIdentity: advice.trackIdentity,
        why: advice.why,
      },
      'info',
    );
  }, [advice, chartLeg, recordingLeg, trackIdentity]);

  return advice;
}
