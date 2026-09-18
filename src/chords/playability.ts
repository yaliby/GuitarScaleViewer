import type { ChordPlayability, ChordVoicing } from './chordTypes';
import { countInnerMutes } from './voicingHeuristics';

type Press = { stringIndex: number; fret: number };

function isNumericPressed(cell: ChordVoicing['frets'][number]): cell is number {
  return typeof cell === 'number' && cell > 0;
}

function pressedFrets(v: ChordVoicing): Press[] {
  const out: Press[] = [];
  for (let s = 0; s < 6; s++) {
    const c = v.frets[s];
    if (c === undefined) {
      continue;
    }
    if (isNumericPressed(c)) {
      out.push({ stringIndex: s, fret: c });
    }
  }
  return out;
}

function maxSpanAllowed(minFret: number): number {
  if (minFret <= 2) {
    return 3;
  }
  if (minFret <= 5) {
    return 4;
  }
  if (minFret <= 9) {
    return 5;
  }
  return 6;
}

function contiguousOrNear(strings: number[]): boolean {
  if (strings.length <= 1) {
    return true;
  }
  const sorted = [...strings].sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 1) {
      gaps += d - 1;
    }
  }
  return gaps <= 1;
}

function inferLowestFretBarre(presses: Press[]): { fret: number; from: number; to: number } | null {
  if (presses.length === 0) {
    return null;
  }
  const minFret = Math.min(...presses.map((p) => p.fret));
  const onMin = presses.filter((p) => p.fret === minFret).map((p) => p.stringIndex);
  if (onMin.length < 2 || !contiguousOrNear(onMin)) {
    return null;
  }
  const from = Math.min(...onMin);
  const to = Math.max(...onMin);
  return { fret: minFret, from, to };
}

function crossingPenalty(v: ChordVoicing): number {
  if (!v.fingers || v.fingers.length !== 6) {
    return 0;
  }
  let penalty = 0;
  const points: Array<{ fret: number; finger: number }> = [];
  for (let s = 0; s < 6; s++) {
    const fret = v.frets[s];
    const finger = v.fingers[s];
    if (fret === undefined) {
      continue;
    }
    if (!isNumericPressed(fret) || finger == null || finger <= 0) {
      continue;
    }
    points.push({ fret, finger });
  }
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      if (a.fret < b.fret && a.finger > b.finger) {
        penalty -= 4;
      } else if (a.fret > b.fret && a.finger < b.finger) {
        penalty -= 4;
      }
    }
  }
  return penalty;
}

function classifyDifficulty(score: number, span: number, fingerCount: number): ChordPlayability['difficulty'] {
  if (score >= 14 && span <= 3 && fingerCount <= 3) {
    return 'easy';
  }
  if (score >= 0) {
    return 'medium';
  }
  return 'hard';
}

export function evaluateVoicingPlayability(v: ChordVoicing): ChordPlayability {
  const presses = pressedFrets(v);
  if (presses.length === 0) {
    const soundedStrings = v.frets.filter((cell) => cell !== 'x').length;
    if (soundedStrings >= 3) {
      return {
        playable: true,
        difficulty: 'easy',
        reason: 'open-friendly',
        playabilityScore: 20,
      };
    }
    return {
      playable: false,
      difficulty: 'hard',
      reason: soundedStrings === 0 ? 'no sounded strings' : 'too few sounded strings',
      playabilityScore: -100,
    };
  }

  const frets = presses.map((p) => p.fret);
  const minFret = Math.min(...frets);
  const maxFret = Math.max(...frets);
  const span = maxFret - minFret;
  const maxAllowed = maxSpanAllowed(minFret);
  if (span > maxAllowed) {
    return {
      playable: false,
      difficulty: 'hard',
      reason: 'too wide span',
      playabilityScore: -120,
    };
  }

  const byFret = new Map<number, number[]>();
  for (const p of presses) {
    const arr = byFret.get(p.fret) ?? [];
    arr.push(p.stringIndex);
    byFret.set(p.fret, arr);
  }

  let inferredBarre = inferLowestFretBarre(presses);
  if (v.barre) {
    const from = Math.min(v.barre.fromString, v.barre.toString);
    const to = Math.max(v.barre.fromString, v.barre.toString);
    inferredBarre = { fret: v.barre.fret, from, to };
  }

  let score = 0;
  const reasons: string[] = [];

  if (inferredBarre) {
    if (inferredBarre.fret > minFret) {
      score -= 8;
      reasons.push('non-lowest barre');
      if (span >= 4) {
        return {
          playable: false,
          difficulty: 'hard',
          reason: 'barre position is unnatural',
          playabilityScore: -90,
        };
      }
    }
    if (inferredBarre.to - inferredBarre.from >= 4) {
      score -= 8;
      reasons.push('long barre');
    } else {
      score -= 3;
      reasons.push('requires barre');
    }
  }

  let fingersUsed = 0;
  if (inferredBarre) {
    fingersUsed += 1;
  }
  for (const [fret, strings] of byFret) {
    if (inferredBarre && fret === inferredBarre.fret) {
      const outside = strings.filter((s) => s < inferredBarre.from || s > inferredBarre.to).length;
      fingersUsed += outside;
      continue;
    }
    fingersUsed += 1;
  }

  if (!inferredBarre && fingersUsed > 4) {
    return {
      playable: false,
      difficulty: 'hard',
      reason: 'too many fingers without barre',
      playabilityScore: -95,
    };
  }
  if (inferredBarre && fingersUsed > 4) {
    return {
      playable: false,
      difficulty: 'hard',
      reason: 'too many fingers',
      playabilityScore: -95,
    };
  }

  const innerMutes = countInnerMutes(v);
  if (innerMutes > 0) {
    score -= innerMutes * 3;
    reasons.push('inner muted string');
  }

  if (minFret >= 10) {
    score -= 6;
    reasons.push('high position');
  } else if (minFret >= 7) {
    score -= 3;
  }

  if (span <= 2) {
    score += 8;
  } else if (span <= 3) {
    score += 4;
  }

  const hasOpen = v.frets.some((c) => c === 'o' || c === 0);
  if (hasOpen) {
    score += 6;
    reasons.push('open-friendly');
  }

  score += crossingPenalty(v);
  if (score < -12 && v.fingers) {
    reasons.push('awkward finger order');
  }

  if ((v.tags ?? []).includes('compact')) {
    score += 3;
  }

  const difficulty = classifyDifficulty(score, span, fingersUsed);
  return {
    playable: true,
    difficulty,
    reason: reasons[0] ?? 'playable',
    playabilityScore: score,
  };
}

