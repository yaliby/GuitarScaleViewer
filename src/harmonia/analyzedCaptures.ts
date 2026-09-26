const KEY = "gsv.harmonia.analyzed.v1";

type AnalyzedMap = Record<string, string>;

let revision = 0;
const listeners = new Set<() => void>();

export function subscribeAnalyzed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAnalyzedRevision(): number {
  return revision;
}

function bump(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function read(): AnalyzedMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: AnalyzedMap = {};
    for (const [id, fingerprint] of Object.entries(parsed)) {
      if (typeof fingerprint === "string" && fingerprint) out[id] = fingerprint;
    }
    return out;
  } catch {
    return {};
  }
}

export function analyzedCaptureIds(): Set<string> {
  return new Set(Object.keys(read()));
}

export function analyzedFingerprint(id: string): string | null {
  if (!id) return null;
  return read()[id] ?? null;
}

export function markCaptureAnalyzed(id: string, fingerprint: string): void {
  if (!id || !fingerprint) return;
  const next = { ...read(), [id]: fingerprint };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  bump();
}
