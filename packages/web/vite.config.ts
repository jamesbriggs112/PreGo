import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const apiPort = process.env.PREGO_PORT ?? '4310';

/**
 * In dev, Vite is ready before the API has started, so opening the browser straight away shows an
 * error on first load. Wait until the API answers, then open it.
 */
function openWhenApiReady(): Plugin {
  return {
    name: 'prego-open-when-api-ready',
    apply: 'serve',
    configureServer(server) {
      if (process.env.PREGO_OPEN === '0') return;
      server.httpServer?.once('listening', async () => {
        for (let attempt = 0; attempt < 120; attempt++) {
          const ready = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
            .then((r) => r.ok)
            .catch(() => false);
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        server.config.logger.info('  Opening Prego in your browser');
        server.openBrowser();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), openWhenApiReady()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['development'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Opened by openWhenApiReady instead.
    open: false,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
