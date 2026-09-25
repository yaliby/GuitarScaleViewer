import { describe, expect, it } from 'vitest';
import { currentLyricIndex, lineWindow, parseLrc } from './lrc';

const SAMPLE = `[00:12.00]hello
[00:12.00][01:30.50]chorus
[00:25]verse two`;

describe('parseLrc', () => {
  it('expands repeated stamps onto the timeline in time order', () => {
    const lines = parseLrc(SAMPLE);
    expect(lines.map((line) => [line.timeMs, line.text])).toEqual([
      [12_000, 'hello'],
      [12_000, 'chorus'],
      [25_000, 'verse two'],
      [90_500, 'chorus'],
    ]);
    expect(lines.map((line) => line.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('currentLyricIndex', () => {
  const lines = parseLrc('[00:00]a\n[00:10]b\n[00:20]c');

  it('picks the last line whose stamp has been reached', () => {
    expect(currentLyricIndex(lines, 0)).toBe(0);
    expect(currentLyricIndex(lines, 10_000)).toBe(1);
    expect(currentLyricIndex(lines, 19_999)).toBe(1);
    expect(currentLyricIndex(lines, 20_000)).toBe(2);
  });

  it('is null before the first stamp', () => {
    expect(currentLyricIndex(parseLrc('[00:05]later'), 0)).toBeNull();
  });
});

describe('lineWindow', () => {
  const lines = parseLrc('[00:00]a\n[00:10]b');

  it('reports progress through the current line while playing', () => {
    const window = lineWindow(lines, 5_000, true);
    expect(window.current?.text).toBe('a');
    expect(window.next?.text).toBe('b');
    expect(window.progress).toBe(0.5);
  });
});
