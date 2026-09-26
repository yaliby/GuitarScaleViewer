// @ts-nocheck
import type { SavedTrack } from '../domain/types';
import { toHarte } from '../domain/chord';

export interface AnalysisExport {
  filename: string;
  mediaType: 'application/json' | 'text/plain';
  contents: string;
}

export function createTimelineExport(record: SavedTrack): AnalysisExport {
  return {
    filename: record.track.name.replace(/[^a-zA-Z0-9 ._-]/g, '_') + '.lab',
    mediaType: 'text/plain',
    contents: record.analysis.segments
      .map((segment) => `${segment.start}\t${segment.end}\t${toHarte(segment.chord)}\n`)
      .join(''),
  };
}

export function createAnalysisExport(record: SavedTrack): AnalysisExport {
  return {
    filename: record.track.name.replace(/[^a-zA-Z0-9 ._-]/g, '_') + '.harmonia.json',
    mediaType: 'application/json',
    contents: JSON.stringify(record, null, 2),
  };
}
