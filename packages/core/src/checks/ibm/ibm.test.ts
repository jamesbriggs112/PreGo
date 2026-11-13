import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import type { RawFinding, Ticket } from '../../types.js';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { guidanceFor } from '../guidance.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-ibm-'));
let alone: RawFinding[];
let both: RawFinding[];
let tickets: Ticket[];

/** IBM rules that report the same problems as the axe rules bad-site fails. */
const AXE_EQUIVALENTS = ['img_alt_valid', 'a_text_purpose', 'input_label_exists', 'html_lang_exists', 'text_contrast_sufficient'];

beforeAll(async () => {
  const db = new PregoDb(':memory:');
  const a = await runAudit(db, { project: 'IBM only', target: 'fixtures/bad-site', checks: ['ibm'], delayMs: 0, dataDir });
  alone = db.getRawFindings(a.run.id);
  const b = await runAudit(db, { project: 'Both engines', target: 'fixtures/bad-site', checks: ['axe', 'ibm'], delayMs: 0, dataDir });
  both = db.getRawFindings(b.run.id);
  tickets = db.getTickets(b.run.id);
  db.close();
}, 240_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('IBM Equal Access as a second engine', () => {
  it('finds the bad-site defects on its own, mapped to WCAG', () => {
    const rules = new Set(alone.map((f) => f.ruleId));
    for (const rule of ['img_alt_valid', 'html_lang_exists']) expect(rules).toContain(rule);
    const alt = alone.find((f) => f.ruleId === 'img_alt_valid')!;
    expect(alt).toMatchObject({ engine: 'ibm', category: 'A11Y', wcagCriteria: expect.arrayContaining(['1.1.1']), wcagLevel: 'A' });
    expect(alt.selector).toMatch(/img/);
  });

  it('drops everything axe already reported on the same element, so there are no duplicate tickets', () => {
    const ibm = both.filter((f) => f.engine === 'ibm');
    expect(ibm.filter((f) => AXE_EQUIVALENTS.includes(f.ruleId))).toEqual([]);
    expect(ibm.length).toBeLessThan(alone.length);
    // Every remaining IBM ticket is about an element and criterion axe didn't report.
    const axeKeys = new Set(both.filter((f) => f.engine === 'axe-core').flatMap((f) => f.wcagCriteria.map((c) => `${f.locationId}|${f.component}|${c}`)));
    for (const f of ibm) expect(f.wcagCriteria.some((c) => axeKeys.has(`${f.locationId}|${f.component}|${c}`))).toBe(false);
    expect(tickets.filter((t) => t.engine === 'axe-core').length).toBeGreaterThan(5);
  });

  it('places findings on the element, or on the frame they were found in, never on a page that has a language', async () => {
    const db = new PregoDb(':memory:');
    const { run } = await runAudit(db, { project: 'Frames', target: 'fixtures/frame-cases', checks: ['ibm'], delayMs: 0, dataDir });
    const found = db.getRawFindings(run.id);
    db.close();
    expect(found.filter((f) => f.selector === 'html')).toEqual([]);
    const lang = found.filter((f) => f.ruleId === 'html_lang_exists');
    for (const f of lang) expect(f).toMatchObject({ selector: expect.stringMatching(/iframe/), failureSummary: expect.stringMatching(/^Inside the embedded frame/) });
    for (const f of found.filter((f) => f.ruleId === 'svg_graphics_labelled')) expect(f.selector).toMatch(/svg|#icon/);
  }, 120_000);

  it('has plain-English wording for every rule IBM can raise', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<p>x</p>');
      await page.addScriptTag({ path: join(dirname(createRequire(import.meta.url).resolve('accessibility-checker-engine/package.json')), 'ace.js') });
      const rules = await page.evaluate(() => {
        type Checker = { getGuidelines(): { id: string; checkpoints: { rules?: { id: string; level: string }[] }[] }[] };
        const checker = new (window as unknown as { ace: { Checker: new () => Checker } }).ace.Checker();
        const wcag = checker.getGuidelines().find((g) => g.id === 'WCAG_2_2')!;
        return [...new Set(wcag.checkpoints.flatMap((cp) => (cp.rules ?? []).filter((r) => r.level === 'VIOLATION').map((r) => r.id)))];
      });
      expect(rules.length).toBeGreaterThan(100);
      expect(rules.filter((id) => !guidanceFor('ibm', id))).toEqual([]);
      expect(guidanceFor('ibm', 'aria_navigation_label_unique', ['1.3.1'])).toMatchObject({ title: 'Several menus have the same label', recommendation: expect.stringContaining('aria-label') });
      // Rules axe also has read the same as axe's.
      expect(guidanceFor('ibm', 'html_lang_exists')?.title).toBe(guidanceFor('axe-core', 'html-has-lang')?.title);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
