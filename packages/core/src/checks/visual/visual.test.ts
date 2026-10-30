import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import { compareScreenshots } from './visual.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-visual-'));
const site = join(dataDir, 'site');
const db = new PregoDb(':memory:');

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function png(width: number, height: number, paint?: (x: number, y: number) => boolean): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const on = paint?.(i % width, Math.floor(i / width));
    image.data.set(on ? [200, 30, 30, 255] : [255, 255, 255, 255], i * 4);
  }
  return PNG.sync.write(image);
}

describe('changes since the last audit', () => {
  it('measures the changed share and where it is', () => {
    const diff = compareScreenshots(png(100, 200), png(100, 200, (_x, y) => y >= 50 && y < 70))!;
    expect(diff.changed).toBeCloseTo(0.1, 2);
    expect(diff.box).toEqual({ top: 50, bottom: 69 });
    expect(PNG.sync.read(diff.image!).height).toBe(59);
    expect(compareScreenshots(png(100, 200), png(100, 200))!.changed).toBe(0);
    expect(compareScreenshots(png(100, 200), png(120, 200))).toBeNull();
  });

  it('reports only the page that changed, with the differences as evidence', async () => {
    cpSync('fixtures/bad-site', site, { recursive: true });
    const first = await runAudit(db, { project: 'Visual', target: site, checks: ['visual'], delayMs: 0, dataDir });
    expect(db.getTickets(first.run.id)).toEqual([]);

    const about = join(site, 'about.html');
    writeFileSync(about, readFileSync(about, 'utf8').replace('<main', '<div style="height:400px;background:#c00">New promo banner</div><main'));
    const second = await runAudit(db, { project: 'Visual', target: site, checks: ['visual'], delayMs: 0, dataDir });
    const tickets = db.getTickets(second.run.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ category: 'UI', severity: 'Medium', title: expect.stringMatching(/^The page looks different from the last audit/) });
    expect(new URL(tickets[0].exampleLocation!).pathname).toBe('/about.html');
    expect(tickets[0].actual).toMatch(/^About \d+% of the page looks different from the audit on \d{4}-\d{2}-\d{2}, mostly between \d+px and \d+px from the top\.( The page is \d+px taller\.)?$/);
    const crop = db.getOccurrences(second.run.id, tickets[0].ticketId)[0].crop!;
    expect(PNG.sync.read(readFileSync(join(second.runDir, crop))).width).toBeGreaterThan(0);
  }, 120_000);
});
