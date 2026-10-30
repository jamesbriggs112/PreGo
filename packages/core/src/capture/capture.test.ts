import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PregoDb } from '../db/database.js';
import { runAudit, type AuditResult } from '../audit/run-audit.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-capture-'));
let db: PregoDb;
let result: AuditResult;

beforeAll(async () => {
  db = new PregoDb(':memory:');
  result = await runAudit(db, { project: 'Acme', target: 'fixtures/bad-site', dataDir, delayMs: 0, viewports: ['desktop', 'mobile'] });
}, 120_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Count pixels close to the highlight colour (#e6007e). */
function highlightPixels(path: string): number {
  const png = PNG.sync.read(readFileSync(path));
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (Math.abs(r - 0xe6) < 30 && g < 40 && Math.abs(b - 0x7e) < 30) count++;
  }
  return count;
}

describe('screenshot capture', () => {
  it('audits every bad-site page at both viewports and saves full-page screenshots', () => {
    expect(result.run.status).toBe('complete');
    const audited = result.locations.filter((l) => l.audited);
    expect(audited).toHaveLength(5);
    for (const location of audited) {
      expect(Object.keys(location.screenshots).sort()).toEqual(['desktop', 'mobile']);
      for (const path of Object.values(location.screenshots)) expect(existsSync(join(result.runDir, path))).toBe(true);
    }
  });

  it('records the broken link as an unaudited location', () => {
    const broken = result.locations.find((l) => l.url.endsWith('/products/mark-iv.html'))!;
    expect(broken).toMatchObject({ audited: false, statusCode: 404 });
    expect(broken.notAuditedReason).toMatch(/HTTP 404, linked from/);
  });

  it('gives every finding a cropped image with the problem outlined', () => {
    const findings = db.getRawFindings(result.run.id);
    expect(findings.length).toBeGreaterThan(10);
    for (const finding of findings) {
      expect(finding.crop, `${finding.ruleId} ${finding.selector}`).not.toBeNull();
      const path = join(result.runDir, finding.crop!);
      const png = PNG.sync.read(readFileSync(path));
      expect(png.width).toBeGreaterThan(0);
      expect(highlightPixels(path), `${finding.ruleId} ${finding.selector} has no outline`).toBeGreaterThan(50);
    }
  });

  it('crops around the element rather than returning the whole page', () => {
    const hero = db.getRawFindings(result.run.id).find((f) => f.ruleId === 'image-alt' && f.viewport === 'desktop' && f.html.includes('hero'))!;
    const png = PNG.sync.read(readFileSync(join(result.runDir, hero.crop!)));
    // Hero is 640 × 240; with padding the crop should be close to that, not the 1440px-wide page.
    expect(png.width).toBeLessThan(800);
    expect(png.height).toBeLessThan(400);
  });
});
