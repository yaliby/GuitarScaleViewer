import path from 'node:path';

/** Both layouts, so a Windows Scripts venv is found even when the host check runs the same list. */
export const CHORDSYNC_VENV_RELATIVE = ['.venv/bin/python', '.venv/Scripts/python.exe'] as const;

export function chordsyncPackageDir(root: string, siblingHasPackage: boolean): string {
  if (siblingHasPackage) return path.resolve(root, '../ChordSync');
  return path.join(root, 'src-tauri/sidecars/chordsync');
}

/**
 * Interpreter for the Vite ChordSync sidecar.
 * `CHORDSYNC_PYTHON` wins, then a sibling checkout venv, then the vendored sidecar venv.
 * The key-analyzer environment is intentionally not a candidate: it does not install
 * `src-tauri/sidecars/chordsync/requirements.txt`.
 */
export function resolveChordsyncPython(options: {
  root: string;
  configured?: string;
  platform: NodeJS.Platform;
  exists: (candidate: string) => boolean;
  siblingHasPackage: boolean;
}): string {
  const configured = options.configured?.trim();
  if (configured && options.exists(configured)) return configured;

  const directories = [
    chordsyncPackageDir(options.root, options.siblingHasPackage),
    path.join(options.root, 'src-tauri/sidecars/chordsync'),
  ];
  const seen = new Set<string>();
  for (const directory of directories) {
    if (seen.has(directory)) continue;
    seen.add(directory);
    for (const relative of CHORDSYNC_VENV_RELATIVE) {
      const candidate = path.join(directory, relative);
      if (options.exists(candidate)) return candidate;
    }
  }
  return options.platform === 'win32' ? 'py' : 'python3';
}
