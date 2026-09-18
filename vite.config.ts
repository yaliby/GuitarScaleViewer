import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Kept in step with the webview's devUrl by dev.sh, which picks a free port and passes the
 * same number to both. Hard-coding it in two files meant a busy 1420 either refused to start
 * or, worse, left Tauri pointed at whatever stale server already held the port.
 */
const DEV_PORT = Number(process.env.GSV_DEV_PORT ?? 1420);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Bind IPv4 explicitly: WebKitGTK often resolves localhost to 127.0.0.1,
    // while Vite's default "localhost" can listen on ::1 only.
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
