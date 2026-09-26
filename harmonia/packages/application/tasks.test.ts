// @ts-nocheck
import { expect, it } from 'vitest';
import { LatestTask } from './tasks';
it('invalidates a finished callback after replacement or explicit cancellation', () => {
  const tasks = new LatestTask();
  const a = tasks.begin();
  const b = tasks.begin();
  expect(tasks.current(a)).toBe(false);
  expect(tasks.current(b)).toBe(true);
  tasks.cancel();
  expect(tasks.current(b)).toBe(false);
});
