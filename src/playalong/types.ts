export type TimedLyricLine = {
  timeMs: number;
  text: string;
  index: number;
};

export type ChartSeg = {
  t: string | null;
  c: string | null;
};

export type ChartLine = {
  lyric: string;
  rtl: boolean;
  chordsOnly: boolean;
  segs: ChartSeg[];
};

export type ChartSection = {
  label: string;
  lines: ChartLine[];
};

export type ScrapedChart = {
  source: string;
  sourceUrl: string;
  /** The key the site declares, when it declares one. Ultimate Guitar's is the key as it sounds. */
  key: string | null;
  /**
   * The fret the site says the capo goes on, when it says. The chords are written as the shapes, so
   * the song sounds this many semitones above them. Absent from charts scraped before it was read.
   */
  capo?: number | null;
  title: string | null;
  artist: string | null;
  notes: string[];
  sections: ChartSection[];
};

export type PlayAlongLyrics = {
  provider: string;
  title: string | null;
  artist: string | null;
  plain: string | null;
  synced: TimedLyricLine[];
  confidence: number;
};

export type PlayAlongTrack = {
  title: string;
  artist: string | null;
  album: string | null;
};

export type PlayAlongStatus =
  | 'idle'
  | 'loading'
  | 'chart'
  | 'lyrics'
  | 'plain'
  | 'none'
  | 'desktop_only'
  | 'error';

export type PlayAlongPayload = {
  status: PlayAlongStatus | string;
  reason?: string | null;
  track: PlayAlongTrack | null;
  lyrics: PlayAlongLyrics | null;
  chart: ScrapedChart | null;
  chartLyricLines?: string[];
  chartHtml?: string | null;
};

export type DevSourcePanel = {
  status: string;
  reason: string | null;
  videoId?: string | null;
  language?: string | null;
  activeIndex: number | null;
  lines: TimedLyricLine[];
};
