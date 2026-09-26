export type ChordJob = {
  stage: string;
  progress: number;
};

let jobs: Record<string, ChordJob> = {};
const listeners = new Set<() => void>();

export function subscribeChordJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChordJobs(): Record<string, ChordJob> {
  return jobs;
}

export function setChordJob(id: string, job: ChordJob | null): void {
  if (!id) return;
  const next = { ...jobs };
  if (job) next[id] = job;
  else delete next[id];
  jobs = next;
  for (const listener of listeners) listener();
}

export function resetChordJobsForTests(): void {
  jobs = {};
  for (const listener of listeners) listener();
}
