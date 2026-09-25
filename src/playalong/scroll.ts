function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * ChordSync's chart scroll: ease the scroller so the line sits in the middle.
 * `scrollIntoView({ behavior: 'smooth' })` fights itself on every line change.
 */
export function scrollLineToCenter(
  scroller: HTMLElement,
  el: HTMLElement,
  duration = 420,
  rafHolder: { id: number | null },
): void {
  const rect = el.getBoundingClientRect();
  const host = scroller.getBoundingClientRect();
  const start = scroller.scrollTop;
  const target = start + rect.top - host.top - host.height / 2 + rect.height / 2;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const end = Math.max(0, Math.min(target, max));
  if (Math.abs(end - start) < 4) return;
  if (rafHolder.id != null) cancelAnimationFrame(rafHolder.id);
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    scroller.scrollTop = start + (end - start) * ease(p);
    if (p < 1) rafHolder.id = requestAnimationFrame(step);
    else rafHolder.id = null;
  };
  rafHolder.id = requestAnimationFrame(step);
}

export function hasHebrew(value: string | null | undefined): boolean {
  return /[\u0590-\u05FF]/.test(value || '');
}
