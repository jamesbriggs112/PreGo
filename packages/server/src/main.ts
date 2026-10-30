// Starts the Prego server: `npm start` (production, serves the built GUI) or `npm run dev` (API only;
// Vite serves the GUI and proxies /api here).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PregoDb, loadDummyData } from '@prego/core';
import { buildApp } from './app.js';

// src/ and dist/ both sit one level below packages/server, so these work in dev and production.
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = resolve(process.env.PREGO_DATA_DIR ?? join(packageDir, '../../data'));
const webDist = join(packageDir, '../web/dist');
const port = Number(process.env.PREGO_PORT ?? 4310);
const serveGui = process.env.NODE_ENV !== 'development' && existsSync(join(webDist, 'index.html'));

const db = new PregoDb(join(dataDir, 'prego.sqlite'));
const interrupted = db.failInterruptedRuns('Prego stopped while this audit was running. Start a new audit to get results.');
if (interrupted) console.log(`Marked ${interrupted} interrupted audit(s) as failed.`);
const dummyData = loadDummyData(join(packageDir, '../../config/dummy-data.json'));
const { app } = await buildApp({ db, dataDir, webDist: serveGui ? webDist : undefined, logger: process.env.PREGO_LOG === '1', dummyData });

// Localhost only: Prego handles client data and must not be reachable from the network.
await app.listen({ host: '127.0.0.1', port });
const url = `http://localhost:${port}/`;
console.log(serveGui ? `Prego is running at ${url}` : `Prego API on ${url}api (GUI served by Vite in dev)`);
console.log(`Data folder: ${dataDir}`);

if (serveGui && process.env.PREGO_OPEN !== '0' && process.platform === 'darwin') {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    console.log('\nStopping Prego…');
    await app.close();
    db.close();
    process.exit(0);
  });
}
