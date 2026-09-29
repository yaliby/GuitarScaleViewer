import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChordsyncPython } from './chordsyncPython';

const root = path.resolve('/work/GuitarScaleViewer');
const sidecar = path.join(root, 'src-tauri/sidecars/chordsync');
const sibling = path.resolve(root, '../ChordSync');

function resolve(options: {
  platform: NodeJS.Platform;
  present: string[];
  configured?: string;
  siblingHasPackage?: boolean;
}): string {
  const present = new Set(options.present);
  return resolveChordsyncPython({
    root,
    configured: options.configured,
    platform: options.platform,
    siblingHasPackage: options.siblingHasPackage ?? false,
    exists: (candidate) => present.has(candidate),
  });
}

describe('resolveChordsyncPython', () => {
  it('uses the Windows sidecar venv when that is the interpreter that exists', () => {
    const windowsPython = path.join(sidecar, '.venv/Scripts/python.exe');
    expect(
      resolve({
        platform: 'win32',
        present: [windowsPython],
      }),
    ).toBe(windowsPython);
  });

  it('prefers CHORDSYNC_PYTHON over a discovered venv', () => {
    const configured = 'C:/tools/chordsync/python.exe';
    expect(
      resolve({
        platform: 'win32',
        configured,
        present: [configured, path.join(sidecar, '.venv/Scripts/python.exe')],
      }),
    ).toBe(configured);
  });

  it('falls through a sibling checkout that has no venv to the Windows sidecar venv', () => {
    const windowsPython = path.join(sidecar, '.venv/Scripts/python.exe');
    expect(
      resolve({
        platform: 'win32',
        siblingHasPackage: true,
        present: [windowsPython],
      }),
    ).toBe(windowsPython);
  });

  it('uses a sibling venv before the vendored copy', () => {
    const siblingPython = path.join(sibling, '.venv/bin/python');
    expect(
      resolve({
        platform: 'linux',
        siblingHasPackage: true,
        present: [siblingPython, path.join(sidecar, '.venv/bin/python')],
      }),
    ).toBe(siblingPython);
  });

  it('never hands Linux the Windows python.exe from a shared checkout', () => {
    const linuxPython = path.join(sidecar, '.venv-linux/bin/python');
    expect(
      resolve({
        platform: 'linux',
        present: [path.join(sidecar, '.venv/Scripts/python.exe'), linuxPython],
      }),
    ).toBe(linuxPython);
    expect(
      resolve({
        platform: 'linux',
        present: [path.join(sidecar, '.venv/Scripts/python.exe')],
      }),
    ).toBe('python3');
  });

  it('falls back to the platform launcher only when no venv exists', () => {
    expect(resolve({ platform: 'win32', present: [] })).toBe('py');
    expect(resolve({ platform: 'linux', present: [] })).toBe('python3');
  });
});
