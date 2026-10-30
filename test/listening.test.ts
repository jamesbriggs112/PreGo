// Prego handles client data, so nothing it runs may accept connections from the network. Crawlee's
// bundled proxy used to listen on every interface (see patches/), which let anyone on the network relay
// requests to Prego's API. This checks every listening socket in Prego and its browsers during a real
// audit of a web address.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PregoDb, runAudit, serveFolder, type StaticServer } from '@prego/core';

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), 'prego-listen-'));
let site: StaticServer;

/** Output of a command that exits 1 when it finds nothing (pgrep, lsof). */
async function output(command: string, args: string[]): Promise<string> {
  try {
    return (await run(command, args, { encoding: 'utf8' })).stdout;
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? '';
  }
}

/** This process and every process it started (the browsers), recursively. */
async function processTree(pid = process.pid): Promise<number[]> {
  const children = (await output('pgrep', ['-P', String(pid)])).split('\n').filter(Boolean).map(Number);
  return [pid, ...(await Promise.all(children.map((child) => processTree(child)))).flat()];
}

/** host:port of every TCP socket Prego or its browsers are listening on. */
async function listeningAddresses(): Promise<string[]> {
  const out = await output('lsof', ['-nP', '-a', '-p', (await processTree()).join(','), '-iTCP', '-sTCP:LISTEN', '-Fn']);
  return out
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
});

afterAll(async () => {
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('network exposure', () => {
  it('listens only on this computer while auditing a web address', async () => {
    const seen = new Set<string>();
    const db = new PregoDb(':memory:');
    let auditing = true;
    // Sample repeatedly while the audit runs, one lsof at a time.
    const sampler = (async () => {
      while (auditing) {
        (await listeningAddresses()).forEach((a) => seen.add(a));
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    try {
      await runAudit(db, { project: 'Acme', target: site.url, dataDir, delayMs: 300 });
    } finally {
      auditing = false;
      await sampler;
      db.close();
    }
    (await listeningAddresses()).forEach((a) => seen.add(a));
    expect(seen.size).toBeGreaterThan(0);
    const exposed = [...seen].filter((address) => !/^(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(address));
    expect(exposed).toEqual([]);
  }, 120_000);
});
