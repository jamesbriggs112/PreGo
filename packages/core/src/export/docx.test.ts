import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PregoDb } from '../db/database.js';
import { runAudit } from '../audit/run-audit.js';
import { buildExportPlan, type ExportPlan } from './plan.js';
import { categoryScore, reportDocx } from './docx.js';

const dataDir = mkdtempSync(join(tmpdir(), 'prego-docx-'));
let plan: ExportPlan;
let zip: JSZip;
let xml: string;
let text: string;

beforeAll(async () => {
  const db = new PregoDb(':memory:');
  const { run, runDir } = await runAudit(db, { project: 'Acme Widgets', target: 'fixtures/bad-site', dataDir, delayMs: 0 });
  plan = buildExportPlan(db, run.id);
  zip = await JSZip.loadAsync(await reportDocx(plan, runDir));
  xml = await zip.file('word/document.xml')!.async('string');
  text = xml.replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('report.docx', () => {
  it('has every section from the spec, in order', () => {
    const headings = [
      'UX, UI and accessibility audit',
      '2. Executive summary',
      '3. Scope and method',
      '4. Findings by category',
      '4.1 Accessibility',
      '5. Site map summary',
      '6. Comparison with the previous audit',
      '7. Limitations and manual testing',
      'Appendix A: Ticket index',
    ];
    const positions = headings.map((h) => text.indexOf(h));
    expect(positions.every((p) => p >= 0), JSON.stringify(headings.filter((_, i) => positions[i] < 0))).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('labels every exported ticket by ID, in bold, and lists it in the appendix', () => {
    for (const ticket of plan.tickets) {
      expect(xml).toMatch(new RegExp(`<w:b/>(?:(?!</w:r>).)*<w:t[^>]*>${ticket.ticketId}</w:t>`));
      const appendix = text.slice(text.indexOf('Appendix A'));
      expect(appendix).toContain(ticket.ticketId);
    }
  });

  it('embeds example screenshots with alt text and names the file', async () => {
    const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/'));
    expect(media.length).toBeGreaterThanOrEqual(4);
    expect(xml).toMatch(/descr="[^"]*problem outlined"/);
    expect(text).toMatch(/Screenshot: PRG-A11Y-\d{3}_\d{2}\.png/);
  });

  it('links every image to an embedded PNG (Word refuses files with broken image links)', async () => {
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const embeds = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
    expect(embeds.length).toBeGreaterThan(0);
    for (const id of embeds) {
      const target = targets.get(id);
      expect(target, id).toBeDefined();
      const data = await zip.file(`word/${target}`)!.async('nodebuffer');
      expect(data.toString('ascii', 1, 4)).toBe('PNG');
    }
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypes).toMatch(/Extension="png"/);
  });

  it('uses plain English and makes no compliance claims', () => {
    expect(text).toContain('Images have no text alternative');
    expect(text).toContain('Why it matters:');
    expect(text).not.toMatch(/\b(is compliant|are compliant|fully accessible|passes WCAG|passed WCAG|WCAG compliant)\b/i);
    expect(text).toContain('does not show that the product meets WCAG');
  });

  it('names a local folder target rather than its temporary server address', () => {
    expect(text).toContain('fixtures/bad-site (local folder)');
    expect(text).not.toMatch(/Product: http:\/\/127\.0\.0\.1/);
  });

  it('reports categories that were not checked as "Not checked", not as a perfect score', () => {
    const summary = text.slice(text.indexOf('Scores by category'), text.indexOf('Top issues'));
    expect(summary).toMatch(/Security\s*Not checked/);
    expect(summary).not.toMatch(/Security\s*100/);
  });
});

describe('categoryScore', () => {
  it('falls with severity-weighted issues but never reaches zero quickly', () => {
    expect(categoryScore([])).toBe(100);
    expect(categoryScore(['Critical'])).toBe(81);
    expect(categoryScore(['Low'])).toBe(98);
    expect(categoryScore(Array(20).fill('High'))).toBe(29);
  });
});
