import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PregoDb } from '../../db/database.js';
import { runAudit } from '../../audit/run-audit.js';
import type { RawFinding } from '../../types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-a11y-custom-'));
let db: PregoDb;
let findings: RawFinding[];
let byPage: Map<string, Set<string>>;

beforeAll(async () => {
  db = new PregoDb(':memory:');
  const { run, locations } = await runAudit(db, {
    project: 'Cases',
    target: 'fixtures/a11y-cases',
    checks: ['a11y-custom'],
    viewports: ['desktop', 'mobile'],
    auditAll: true,
    delayMs: 0,
  ...{ dataDir },
  });
  findings = db.getRawFindings(run.id);
  const pathOf = new Map(locations.map((l) => [l.id, new URL(l.url).pathname.replace(/^\//, '') || 'index.html']));
  byPage = new Map();
  for (const f of findings) {
    const page = pathOf.get(f.locationId)!;
    byPage.set(page, (byPage.get(page) ?? new Set()).add(`${f.ruleId}@${f.viewport}`));
  }
}, 240_000);

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const rules = (page: string) => [...(byPage.get(page) ?? [])].sort();

describe('custom accessibility checks: each fixture page triggers its check', () => {
  it('the clean control page triggers nothing', () => {
    expect(rules('index.html')).toEqual([]);
  });

  it.each([
    ['keyboard-trap.html', 'keyboard-trap@desktop'],
    ['no-focus.html', 'focus-not-visible@desktop'],
    ['reflow.html', 'reflow@desktop'],
    ['zoom.html', 'zoom-text-clipped@desktop'],
    ['spacing.html', 'text-spacing@desktop'],
    ['no-skip-link.html', 'skip-link-missing@desktop'],
    ['headings.html', 'multiple-h1@desktop'],
    ['no-landmarks.html', 'no-landmarks@desktop'],
    ['duplicate-a.html', 'duplicate-title@desktop'],
    ['duplicate-b.html', 'duplicate-title@desktop'],
  ])('%s raises %s', (page, rule) => {
    expect(rules(page)).toContain(rule);
  });

  it('lets Tab move through video players and frames: no trap, and no missing focus ring on them', () => {
    expect(rules('media.html').filter((r) => /keyboard-trap|focus-not-visible/.test(r))).toEqual([]);
  });

  it('checks touch target size only at touch viewports, and exempts inline links', () => {
    const targets = findings.filter((f) => f.ruleId === 'target-size-touch');
    expect(new Set(targets.map((f) => f.viewport))).toEqual(new Set(['mobile']));
    const onTargetsPage = targets.filter((f) => rules('targets.html').length && f.html.startsWith('<button'));
    expect(onTargetsPage.length).toBeGreaterThanOrEqual(2);
    expect(targets.some((f) => f.html.includes('inline link'))).toBe(false);
  });

  it('reports page-level checks once per page, not once per viewport', () => {
    expect(findings.filter((f) => f.ruleId === 'reflow' && f.viewport === 'mobile')).toEqual([]);
  });

  it('describes what it found, with WCAG references', () => {
    const trap = findings.find((f) => f.ruleId === 'keyboard-trap')!;
    expect(trap).toMatchObject({ selector: '#trap', severity: 'Critical', wcagCriteria: ['2.1.2'], wcagLevel: 'A', category: 'A11Y' });
    const reflow = findings.find((f) => f.ruleId === 'reflow')!;
    expect(reflow).toMatchObject({ selector: '#wide', failureSummary: 'At 320 pixels wide this element is 900px wide, so the page scrolls sideways.' });
    expect(findings.find((f) => f.ruleId === 'zoom-text-clipped')!.selector).toBe('#banner');
    expect(findings.filter((f) => f.ruleId === 'text-spacing').map((f) => f.selector).sort()).toEqual(['#banner', '#tight']);
  });

  it('groups duplicate titles into one site-wide ticket listing both pages', () => {
    const dup = db.getTickets(findings[0].runId).filter((t) => t.ruleId === 'duplicate-title');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ occurrences: 2, locationsAffected: 2 });
  });
});
