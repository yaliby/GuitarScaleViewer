import path from 'node:path';

/**
 * Venv interpreters per platform. The checkout lives on a drive shared by Windows and Linux, so a
 * Windows `.venv/Scripts/python.exe` can exist under Linux, where exec'ing it fails ("MZ...:
 * Invalid argument") and takes Play Along down with it. Linux gets its own `.venv-linux`
 * (made by dev.sh) so it never has to overwrite the Windows venv.
 */
export function chordsyncVenvRelative(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') return ['.venv/Scripts/python.exe'];
  return ['.venv/bin/python', '.venv-linux/bin/python'];
}

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
    for (const relative of chordsyncVenvRelative(options.platform)) {
      const candidate = path.join(directory, relative);
      if (options.exists(candidate)) return candidate;
    }
  }
  return options.platform === 'win32' ? 'py' : 'python3';
}
