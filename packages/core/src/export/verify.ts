import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';

const TICKET_ID = /PRG-[A-Z0-9]+-\d{3,}/g;

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  ticketIds: string[];
}

/**
 * Check an export folder's cross-references (acceptance criterion 6): every ticket ID in report.docx is
 * in tickets.csv exactly once, every ticket in tickets.csv is referenced in the report, and every
 * occurrence belongs to a ticket. Screenshots are embedded in the report, not separate files.
 * The client report (client-report.docx) must have no ticket IDs at all. Exports from before it had its
 * own file put the client layout in report.docx instead, which run.json records.
 */
export async function verifyExport(dir: string): Promise<VerifyResult> {
  const problems: string[] = [];
  for (const file of ['report.docx', 'tickets.csv', 'occurrences.csv']) {
    if (!existsSync(join(dir, file))) problems.push(`Missing ${file}`);
  }
  if (problems.length) return { ok: false, problems, ticketIds: [] };

  const docText = async (file: string) => {
    const zip = await JSZip.loadAsync(readFileSync(join(dir, file)));
    const xml = await zip.file('word/document.xml')!.async('string');
    return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  };
  const reportText = await docText('report.docx');
  if (existsSync(join(dir, 'client-report.docx'))) {
    for (const id of new Set((await docText('client-report.docx')).match(TICKET_ID) ?? [])) problems.push(`${id} is in client-report.docx, which should have no ticket IDs`);
  }

  const readCsv = (file: string) => {
    const rows = parse(readFileSync(join(dir, file), 'utf8').replace(/^\uFEFF/, '')) as string[][];
    const [header, ...body] = rows;
    return body.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
  };
  const tickets = readCsv('tickets.csv');
  const occurrences = readCsv('occurrences.csv');

  const csvIds = tickets.map((t) => t['Ticket ID']);
  const reportIds = new Set(reportText.match(TICKET_ID) ?? []);
  const runJson = join(dir, 'run.json');
  const clientFacing = existsSync(runJson) && (JSON.parse(readFileSync(runJson, 'utf8')) as { reportLayout?: string }).reportLayout === 'client-facing';
  if (clientFacing) {
    for (const id of reportIds) problems.push(`${id} is in a client-facing report.docx, which should have no ticket IDs`);
    for (const o of occurrences) if (!csvIds.includes(o['Ticket ID'])) problems.push(`occurrences.csv refers to ${o['Ticket ID']}, which is not in tickets.csv`);
    return { ok: problems.length === 0, problems, ticketIds: csvIds };
  }
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

  return { ok: problems.length === 0, problems, ticketIds: csvIds };
}
