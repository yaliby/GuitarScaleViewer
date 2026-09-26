// @ts-nocheck
/** Cache/request identity only; never replace the user's raw controlled input. */
export function normalizeSearchQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
export function isMeaningfulSearch(query: string): boolean {
  return (query.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}
