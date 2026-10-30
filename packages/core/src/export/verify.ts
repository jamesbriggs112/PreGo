import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';

const TICKET_ID = /PRG-[A-Z0-9]+-\d{3,}/g;
const SCREENSHOT = /PRG-[A-Z0-9]+-\d{3,}_\d{2,}\.png/g;

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  ticketIds: string[];
}

/**
 * Check an export folder's cross-references (acceptance criterion 6): every ticket ID in report.docx is
 * in tickets.csv exactly once, every ticket in tickets.csv is referenced in the report, and every
 * screenshot named in any file exists in screenshots/.
 */
export async function verifyExport(dir: string): Promise<VerifyResult> {
  const problems: string[] = [];
  for (const file of ['report.docx', 'tickets.csv', 'occurrences.csv', 'screenshots']) {
    if (!existsSync(join(dir, file))) problems.push(`Missing ${file}`);
  }
  if (problems.length) return { ok: false, problems, ticketIds: [] };

  const zip = await JSZip.loadAsync(readFileSync(join(dir, 'report.docx')));
  const xml = await zip.file('word/document.xml')!.async('string');
  const reportText = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');

  const readCsv = (file: string) => {
    const rows = parse(readFileSync(join(dir, file), 'utf8').replace(/^\uFEFF/, '')) as string[][];
    const [header, ...body] = rows;
    return body.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
  };
  const tickets = readCsv('tickets.csv');
  const occurrences = readCsv('occurrences.csv');

  const csvIds = tickets.map((t) => t['Ticket ID']);
  const reportIds = new Set(reportText.match(TICKET_ID) ?? []);
  for (const id of reportIds) {
    const count = csvIds.filter((c) => c === id).length;
    if (count !== 1) problems.push(`${id} is in report.docx but appears ${count} times in tickets.csv`);
  }
  for (const id of new Set(csvIds)) {
    if (!reportIds.has(id)) problems.push(`${id} is in tickets.csv but not referenced in report.docx`);
  }
  for (const o of occurrences) {
    if (!csvIds.includes(o['Ticket ID'])) problems.push(`occurrences.csv refers to ${o['Ticket ID']}, which is not in tickets.csv`);
  }

  const screenshots = new Set(readdirSync(join(dir, 'screenshots')));
  const named = new Set([
    ...(reportText.match(SCREENSHOT) ?? []),
    ...tickets.map((t) => t.Screenshot).filter(Boolean),
    ...occurrences.map((o) => o['Screenshot crop']).filter(Boolean),
  ]);
  for (const file of named) if (!screenshots.has(file)) problems.push(`${file} is named but missing from screenshots/`);
  for (const file of screenshots) {
    const ticketId = file.replace(/_\d+\.png$/, '');
    if (!csvIds.includes(ticketId)) problems.push(`screenshots/${file} doesn't belong to any ticket in tickets.csv`);
  }

  return { ok: problems.length === 0, problems, ticketIds: csvIds };
}
