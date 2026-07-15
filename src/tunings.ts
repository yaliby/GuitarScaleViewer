export type TuningPreset = {
  id: string;
  label: string;
  /** Low E string is index 0 (top), high E is index 5 (bottom). */
  stringLabels: readonly string[];
  /** Pitch classes for open strings, low → high. */
  openStringPcs: readonly number[];
};

export const TUNING_PRESETS: readonly TuningPreset[] = [
  { id: 'standard', label: 'Standard (E A D G B E)', stringLabels: ['E', 'A', 'D', 'G', 'B', 'E'], openStringPcs: [4, 9, 2, 7, 11, 4] },
  { id: 'half-step-down', label: 'Half step down (Eb Ab Db Gb Bb Eb)', stringLabels: ['Eb', 'Ab', 'Db', 'Gb', 'Bb', 'Eb'], openStringPcs: [3, 8, 1, 6, 10, 3] },
  { id: 'drop-d', label: 'Drop D (D A D G B E)', stringLabels: ['D', 'A', 'D', 'G', 'B', 'E'], openStringPcs: [2, 9, 2, 7, 11, 4] },
  { id: 'd-standard', label: 'D Standard (D G C F A D)', stringLabels: ['D', 'G', 'C', 'F', 'A', 'D'], openStringPcs: [2, 7, 0, 5, 9, 2] },
  { id: 'c-standard', label: 'C Standard (C F Bb Eb G C)', stringLabels: ['C', 'F', 'Bb', 'Eb', 'G', 'C'], openStringPcs: [0, 5, 10, 3, 7, 0] },
  { id: 'b-standard', label: 'B Standard (B E A D F# B)', stringLabels: ['B', 'E', 'A', 'D', 'F#', 'B'], openStringPcs: [11, 4, 9, 2, 6, 11] },
  { id: 'drop-c', label: 'Drop C (C G C F A D)', stringLabels: ['C', 'G', 'C', 'F', 'A', 'D'], openStringPcs: [0, 7, 0, 5, 9, 2] },
  { id: 'drop-csharp', label: 'Drop C# (C# G# C# F# A# D#)', stringLabels: ['C#', 'G#', 'C#', 'F#', 'A#', 'D#'], openStringPcs: [1, 8, 1, 6, 10, 3] },
  { id: 'drop-b', label: 'Drop B (B F# B E G# C#)', stringLabels: ['B', 'F#', 'B', 'E', 'G#', 'C#'], openStringPcs: [11, 6, 11, 4, 8, 1] },
  { id: 'open-g', label: 'Open G (D G D G B D)', stringLabels: ['D', 'G', 'D', 'G', 'B', 'D'], openStringPcs: [2, 7, 2, 7, 11, 2] },
  { id: 'open-d', label: 'Open D (D A D F# A D)', stringLabels: ['D', 'A', 'D', 'F#', 'A', 'D'], openStringPcs: [2, 9, 2, 6, 9, 2] },
  { id: 'open-e', label: 'Open E (E B E G# B E)', stringLabels: ['E', 'B', 'E', 'G#', 'B', 'E'], openStringPcs: [4, 11, 4, 8, 11, 4] },
  { id: 'open-a', label: 'Open A (E A E A C# E)', stringLabels: ['E', 'A', 'E', 'A', 'C#', 'E'], openStringPcs: [4, 9, 4, 9, 1, 4] },
  { id: 'open-c', label: 'Open C (C G C G C E)', stringLabels: ['C', 'G', 'C', 'G', 'C', 'E'], openStringPcs: [0, 7, 0, 7, 0, 4] },
  { id: 'dadgad', label: 'DADGAD (D A D G A D)', stringLabels: ['D', 'A', 'D', 'G', 'A', 'D'], openStringPcs: [2, 9, 2, 7, 9, 2] },
  { id: 'dgcgcd', label: 'DGCGCD (D G C G C D)', stringLabels: ['D', 'G', 'C', 'G', 'C', 'D'], openStringPcs: [2, 7, 0, 7, 0, 2] },
] as const;
