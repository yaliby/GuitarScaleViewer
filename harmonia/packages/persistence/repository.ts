// @ts-nocheck
import type { AnalysisRepository, LibraryResult } from '../application/contracts';
import type { SavedTrack } from '../domain/types';
import { validateAnalysis } from '../domain/timeline';
import { validateSourceProvenance } from '../domain/source';

export function validateSavedTrack(value: unknown): SavedTrack {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved track');
  const record = value as SavedTrack;
  validateAnalysis(record.analysis);
  const source = record.source === undefined ? undefined : validateSourceProvenance(record.source);
  if (source?.audio.kind === 'acquired' && source.audio.fingerprint !== record.analysis.fingerprint)
    throw new Error('Acquired audio fingerprint mismatch');
  if (
    !record.track ||
    typeof record.track.id !== 'string' ||
    !record.track.id ||
    typeof record.track.name !== 'string' ||
    record.track.name.length > 1000 ||
    record.track.fingerprint !== record.analysis.fingerprint ||
    !Number.isFinite(record.track.duration) ||
    Math.abs(record.track.duration - record.analysis.duration) > 0.1 ||
    typeof record.track.favorite !== 'boolean' ||
    !Number.isFinite(Date.parse(record.track.importedAt)) ||
    !Array.isArray(record.corrections)
  )
    throw new Error('Corrupt track metadata');
  for (const correction of record.corrections) {
    if (
      !correction ||
      typeof correction.id !== 'string' ||
      correction.analysisId !== record.analysis.id ||
      typeof correction.segmentId !== 'string' ||
      !Number.isFinite(Date.parse(correction.createdAt))
    )
      throw new Error('Corrupt correction history');
    validateAnalysis({ ...record.analysis, segments: [correction.before] });
    validateAnalysis({ ...record.analysis, segments: [correction.after] });
    if (
      correction.before.id !== correction.segmentId ||
      correction.after.id !== correction.segmentId
    )
      throw new Error('Correction segment identity mismatch');
  }
  return source ? { ...record, source } : record;
}
export class BrowserAnalysisRepository implements AnalysisRepository {
  constructor(private name = 'harmonia-v1') {}
  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('Local analysis storage is unavailable'));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const analyses = db.createObjectStore('analyses', { keyPath: 'analysis.id' });
        const quarantine = db.createObjectStore('quarantine', { keyPath: 'id' });
        if (db.objectStoreNames.contains('tracks')) {
          const migratedIds = new Set<string>();
          const cursor = request.transaction!.objectStore('tracks').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            try {
              const record = validateSavedTrack(row.value);
              if (migratedIds.has(record.analysis.id))
                throw new Error(`Duplicate legacy analysis identity: ${record.analysis.id}`);
              // Cursor order determines the first healthy record. Never replace it
              // with another legacy source sharing the same analysis identity.
              analyses.add(record);
              migratedIds.add(record.analysis.id);
            } catch (error) {
              quarantine.put({
                id: String(row.key),
                record: row.value,
                message: error instanceof Error ? error.message : 'Invalid legacy record',
              });
            }
            row.continue();
          };
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('Could not open local library'));
      request.onblocked = () =>
        reject(new Error('Close other Harmonia windows to update the library'));
    });
  }
  async list(): Promise<LibraryResult> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['analyses', 'quarantine'], 'readonly');
        const records = tx.objectStore('analyses').getAll(),
          quarantine = tx.objectStore('quarantine').getAll();
        tx.oncomplete = () => {
          const result: LibraryResult = {
            records: [],
            issues: quarantine.result.map((row: { id: string; message: string }) => ({
              id: row.id,
              message: row.message,
            })),
          };
          for (const [index, value] of records.result.entries()) {
            try {
              result.records.push(validateSavedTrack(value));
            } catch (error) {
              result.issues.push({
                id: typeof value?.analysis?.id === 'string' ? value.analysis.id : `record-${index}`,
                message: error instanceof Error ? error.message : 'Corrupt saved analysis',
              });
            }
          }
          resolve(result);
        };
        tx.onerror = () => reject(new Error('Could not read the local library'));
        tx.onabort = () => reject(new Error('Library read interrupted'));
      });
    } finally {
      db.close();
    }
  }
  async save(record: SavedTrack): Promise<void> {
    const normalized = validateSavedTrack(record);
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('analyses', 'readwrite');
        tx.objectStore('analyses').put(normalized);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Could not save analysis. Storage may be full.'));
        tx.onabort = () => reject(new Error('Analysis save was interrupted'));
      });
    } finally {
      db.close();
    }
  }
}
class NativeAnalysisRepository implements AnalysisRepository {
  async list(): Promise<LibraryResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<LibraryResult>('list_saved_tracks');
    const records: SavedTrack[] = [];
    for (const value of result.records) {
      try {
        records.push(validateSavedTrack(value));
      } catch (error) {
        result.issues.push({
          id: value?.analysis?.id ?? 'unknown',
          message: error instanceof Error ? error.message : 'Invalid saved record',
        });
      }
    }
    return { records, issues: result.issues };
  }
  async save(record: SavedTrack) {
    const normalized = validateSavedTrack(record);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_track', { record: normalized });
  }
}
export function createRepository(): AnalysisRepository {
  // Analyses live in the webview IndexedDB so Fretboard Studio does not need a
  // second SQLite. The song files themselves stay in the capture library.
  return new BrowserAnalysisRepository('fretboard-harmonia-v1');
}
