import type { AnalysisRepository, LibraryResult } from "../../harmonia/packages/application/contracts";
import type { SavedTrack } from "../../harmonia/packages/domain/types";
import { validateSavedTrack } from "../../harmonia/packages/persistence/repository";
import { listRememberedChordAnalyses, rememberChordAnalysis } from "../services/songMemory";

/** Same identity the sidecar uses, so a file copy and an IndexedDB row are one analysis. */
export function chordAnalysisIdentity(record: SavedTrack): string {
  return [
    record.analysis.fingerprint,
    record.analysis.profile,
    record.analysis.pipelineVersion,
    record.analysis.modelVersion,
  ].join("|");
}

/**
 * IndexedDB remains the webview copy. The song-memory file is the copy that
 * survives a wiped webview, and the one a future database can take over.
 */
export class DurableAnalysisRepository implements AnalysisRepository {
  constructor(private inner: AnalysisRepository) {}

  async list(): Promise<LibraryResult> {
    const local = await this.inner.list();
    let disk: unknown[] = [];
    try {
      disk = await listRememberedChordAnalyses();
    } catch {
      disk = [];
    }
    const records = [...local.records];
    const seen = new Set(records.map(chordAnalysisIdentity));
    const issues = [...local.issues];
    disk.forEach((value, index) => {
      try {
        const record = validateSavedTrack(value);
        const identity = chordAnalysisIdentity(record);
        if (seen.has(identity)) return;
        seen.add(identity);
        records.push(record);
      } catch (error) {
        issues.push({
          id: `song-memory-${index}`,
          message: error instanceof Error ? error.message : "Corrupt saved chord analysis",
        });
      }
    });
    return { records, issues };
  }

  async save(record: SavedTrack): Promise<void> {
    const disk = rememberChordAnalysis(record).catch(() => false);
    await this.inner.save(record);
    await disk;
  }
}
