// Acceptance criteria 5 and 6: the CLI produces a complete export from bad-site, and the Word report,
// tickets.csv and occurrences.csv all cross-reference each other. Screenshots live only in the report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';
import { verifyExport } from '@prego/core';

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), 'prego-xref-'));
let exportDir: string;
let cliOutput: string;

/** Run the real CLI from source, as `npm run prego` does. */
async function prego(...args: string[]) {
  return run(process.execPath, ['--conditions=development', '--import', 'tsx', 'packages/cli/src/cli.ts', '--data-dir', dataDir, ...args], {
    timeout: 120_000,
  });
}

beforeAll(async () => {
  const { stdout } = await prego('audit', 'fixtures/bad-site', '--project', 'Acme Widgets', '--viewports', 'desktop,mobile', '--delay', '0', '--quiet');
  cliOutput = stdout;
  exportDir = /Export: (.+)/.exec(stdout)![1].trim();
}, 150_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const readCsv = (file: string) => {
  const [header, ...rows] = parse(readFileSync(join(exportDir, file), 'utf8').replace(/^\uFEFF/, '')) as string[][];
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
};

async function reportText(dir: string) {
  const zip = await JSZip.loadAsync(readFileSync(join(dir, 'report.docx')));
  return (await zip.file('word/document.xml')!.async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}

describe('prego audit (CLI)', () => {
  it('runs to completion and exits', () => {
    expect(cliOutput).toMatch(/Run \d+ complete: 5 pages found, 5 audited, \d+ tickets from \d+ findings\./);
    expect(exportDir).toMatch(/exports[/\\]acme-widgets-\d{4}-\d{2}-\d{2}-\d{4}$/);
  });

  it('writes the full bundle into one folder (criterion 5)', () => {
    expect(readdirSync(exportDir).sort()).toEqual(['occurrences.csv', 'qa-checklist.csv', 'report.docx', 'run.json', 'tickets.csv']);
  });

  it('embeds the screenshots in the report, then deletes them from Prego', async () => {
    const zip = await JSZip.loadAsync(readFileSync(join(exportDir, 'report.docx')));
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/')).length).toBeGreaterThan(0);
    const runDir = join(dataDir, 'runs', readdirSync(join(dataDir, 'runs'))[0]);
    expect(existsSync(join(runDir, 'screenshots'))).toBe(false);
    expect(existsSync(join(runDir, 'crops'))).toBe(false);
  });

  it('raises tickets for every defect type in criterion 2', () => {
    const rules = new Set(readCsv('tickets.csv').map((t) => t['Rule ID']));
    for (const rule of ['image-alt', 'color-contrast', 'label', 'html-has-lang', 'heading-order']) expect(rules).toContain(rule);
  });
});

describe('cross-references (criterion 6)', () => {
  it('every ticket ID in report.docx appears exactly once in tickets.csv', async () => {
    const ids = readCsv('tickets.csv').map((t) => t['Ticket ID']);
    const inReport = new Set((await reportText(exportDir)).match(/PRG-[A-Z0-9]+-\d{3,}/g));
    expect(inReport.size).toBeGreaterThan(0);
    for (const id of inReport) expect(ids.filter((i) => i === id), id).toHaveLength(1);
  });

  it('every ticket in tickets.csv is referenced in report.docx', async () => {
    const text = await reportText(exportDir);
    for (const { 'Ticket ID': id } of readCsv('tickets.csv')) expect(text, id).toContain(id);
  });

  it('passes `prego verify`', async () => {
    const { stdout } = await prego('verify', exportDir);
    expect(stdout).toMatch(/^OK: \d+ tickets cross-reference correctly\./);
  }, 30_000);
});

describe('verifyExport catches broken bundles', () => {
  it('reports a ticket dropped from the CSV', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'prego-broken-'));
    try {
      cpSync(exportDir, broken, { recursive: true });
      const lines = readFileSync(join(broken, 'tickets.csv'), 'utf8').split('\r\n');
      const droppedId = /^"([^"]+)"/.exec(lines[1])![1];
      writeFileSync(join(broken, 'tickets.csv'), [lines[0], ...lines.slice(2)].join('\r\n'));

      const result = await verifyExport(broken);
      expect(result.ok).toBe(false);
      expect(result.problems).toContainEqual(`${droppedId} is in report.docx but appears 0 times in tickets.csv`);
      expect(existsSync(join(broken, 'report.docx'))).toBe(true);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
