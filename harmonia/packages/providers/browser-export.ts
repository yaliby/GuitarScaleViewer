// @ts-nocheck
import type { AnalysisExport } from '../application/export';

/** Browser download boundary; serialization and naming belong to the use case. */
export function downloadAnalysisExport(file: AnalysisExport): void {
  const blob = new Blob([file.contents], { type: file.mediaType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
