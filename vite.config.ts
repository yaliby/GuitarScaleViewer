import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { chordsyncPackageDir, resolveChordsyncPython } from './scripts/chordsyncPython';

/**
 * Kept in step with the webview's devUrl by dev.sh, which picks a free port and passes the
 * same number to both. Hard-coding it in two files meant a busy 1420 either refused to start
 * or, worse, left Tauri pointed at whatever stale server already held the port.
 */
const DEV_PORT = Number(process.env.GSV_DEV_PORT ?? 1420);
const CHORDSYNC_PORT = Number(process.env.CHORDSYNC_HTTP_PORT ?? 18766);

function chordsyncCheckout(root: string): string {
  const sibling = path.resolve(root, '../ChordSync');
  return chordsyncPackageDir(root, existsSync(path.join(sibling, 'chordsync', '__init__.py')));
}

function chordsyncPython(root: string): string {
  const sibling = path.resolve(root, '../ChordSync');
  return resolveChordsyncPython({
    root,
    configured: process.env.CHORDSYNC_PYTHON,
    platform: process.platform,
    exists: existsSync,
    siblingHasPackage: existsSync(path.join(sibling, 'chordsync', '__init__.py')),
  });
}

/** Runs ChordSync's own resolver (LRCLIB + Tab4U/UG) next to Vite. */
function chordsyncSidecar(): Plugin {
  let child: ChildProcess | undefined;
  return {
    name: 'chordsync-sidecar',
    configureServer(server) {
      const projectRoot = server.config.root;
      const sidecarRoot = path.join(projectRoot, 'src-tauri/sidecars/chordsync');
      const script = path.join(sidecarRoot, 'chordsync_sidecar.py');
      if (!existsSync(script)) {
        server.config.logger.warn('[chordsync] sidecar script missing');
        return;
      }
      const python = chordsyncPython(projectRoot);
      const packageRoot = process.env.CHORDSYNC_ROOT || chordsyncCheckout(projectRoot);
      child = spawn(python, [script, '--http', `127.0.0.1:${CHORDSYNC_PORT}`], {
        cwd: sidecarRoot,
        env: {
          ...process.env,
          CHORDSYNC_ROOT: packageRoot,
          PYTHONPATH: packageRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        server.config.logger.info(`[chordsync] ${chunk.toString().trim()}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        server.config.logger.info(`[chordsync] ${chunk.toString().trim()}`);
      });
      child.on('exit', (code) => {
        if (code) {
          server.config.logger.warn(`[chordsync] sidecar exited ${code}`);
        }
        child = undefined;
      });
      const stop = () => {
        child?.kill();
        child = undefined;
      };
      server.httpServer?.once('close', stop);
    },
  };
}

export default defineConfig({
  plugins: [react(), chordsyncSidecar()],
  clearScreen: false,
  worker: { format: 'es' },
  server: {
    // Bind IPv4 explicitly: WebKitGTK often resolves localhost to 127.0.0.1,
    // while Vite's default "localhost" can listen on ::1 only.
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/chordsync': {
        target: `http://127.0.0.1:${CHORDSYNC_PORT}`,
        rewrite: (url) => url.replace(/^\/chordsync/, '') || '/',
      },
    },
  },
});
