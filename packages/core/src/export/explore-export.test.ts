import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { exportRun, type ExportResult } from './bundle.js';
import { verifyExport } from './verify.js';
import { layoutStateMap } from '../explore/layout.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-explore-export-'));
let exported: ExportResult;
let text: string;
let zip: JSZip;

beforeAll(async () => {
  const db = new PregoDb(':memory:');
  const { run } = await runAudit(db, { project: 'Museum of Making', target: 'fixtures/kiosk-app', mode: 'explore', viewports: ['kiosk-landscape'], dataDir });
  exported = await exportRun(db, run.id, { dataDir });
  zip = await JSZip.loadAsync(readFileSync(exported.files.report));
  text = (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}, 240_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('exporting an interactive exploration', () => {
  it('writes state-map.png alongside the usual bundle, and cross-references cleanly', async () => {
    const png = readFileSync(join(exported.dir, 'state-map.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeGreaterThan(1000);
    expect(existsSync(exported.files.tickets)).toBe(true);
    expect(await verifyExport(exported.dir)).toMatchObject({ ok: true, problems: [] });
  });

  it('describes the exploration in the report, with the state map and every screen', () => {
    expect(text).toContain('Interactive exploration of fixtures/kiosk-app (local folder): 16 screens found and audited');
    expect(text).toContain('5. State map summary');
    expect(text).not.toContain('5. Site map summary');
    expect(text).toMatch(/Not pressed, for safety\s*“Send to my email”/);
    for (const screen of ['Gallery Guide', 'Opening Times', 'Textile Mills']) expect(text).toContain(screen);
    expect(text).toContain('Screen has no way back or home');
    expect(text).toContain('Button does nothing');
    expect(text).toMatch(/Only screens Prego could reach by pressing controls/);
  });

  it('embeds the state map diagram in the report', async () => {
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toMatch(/descr="State map of 16 screens"/);
  });
});

describe('layoutStateMap', () => {
  it('keeps every screen’s children in their own block of rows, so routes never cross', () => {
    const s = (id: number, keys: string[]) => ({ id, title: String(id), depth: keys.length, stepKeys: keys });
    const states = [s(1, []), s(2, ['a']), s(3, ['b']), s(4, ['a', 'x']), s(5, ['a', 'y']), s(6, ['b', 'z'])];
    const { states: placed, links, height } = layoutStateMap(states, []);
    const y = (id: number) => placed.find((p) => p.id === id)!.y;
    // 2's children (4, 5) are above 3's child (6), and each parent is level with its first child.
    expect(y(4)).toBeLessThan(y(5));
    expect(y(5)).toBeLessThan(y(6));
    expect(y(2)).toBe(y(4));
    expect(y(3)).toBe(y(6));
    expect(links.filter((l) => l.tree)).toHaveLength(5);
    expect(height).toBeGreaterThan(0);
  });
});
