// T32: the packaged Mac app starts Prego and serves the GUI without Terminal. Building the app takes
// several minutes and downloads Electron, so this runs only after `npm run desktop:build`.
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const binary = join('packages', 'desktop', 'out', `Prego-darwin-${process.arch}`, 'Prego.app', 'Contents', 'MacOS', 'Prego');

describe.skipIf(process.platform !== 'darwin' || !existsSync(binary))('desktop app', () => {
  it('starts its own server and serves the GUI', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'prego-desktop-'));
    try {
      const { stdout } = await promisify(execFile)(binary, [], { env: { ...process.env, PREGO_DESKTOP_SMOKE: '1', PREGO_DATA_DIR: dataDir }, timeout: 90_000 });
      expect(stdout).toMatch(/PREGO_DESKTOP_OK http:\/\/127\.0\.0\.1:\d+/);
      expect(existsSync(join(dataDir, 'prego.sqlite'))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
