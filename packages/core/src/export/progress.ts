import { Paragraph, Table, TextRun } from 'docx';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { categoryScores, formatDate, para, table } from './docx.js';
import { shortRef } from './action-plan.js';

// Progress since the project's previous audit: the score per area then and now, what was fixed,
// what's new and what's still open. Issues are matched by their ticket ID, which stays the same
// for the same problem from one audit to the next.

/** Most fixed issues listed by name. */
const MAX_FIXED = 15;

export interface Progress {
  fixed: { ref: string; title: string }[];
  added: number;
  stillOpen: number;
  scores: { name: string; before: number | null; now: number | null }[];
}

export function progress(plan: ExportPlan): Progress | null {
  const previous = plan.previous;
  if (!previous) return null;
  const now = new Set(plan.tickets.map((t) => t.ticketId));
  const fixed = previous.tickets.filter((t) => !now.has(t.ticketId)).map((t) => ({ ref: shortRef(t.ticketId), title: t.title }));
  const before = categoryScores({ ...plan, run: previous.run, locations: previous.locations, tickets: previous.tickets as PlannedTicket[] });
  const current = categoryScores(plan);
  return {
    fixed,
    added: plan.tickets.filter((t) => t.sinceLast === 'New').length,
    stillOpen: plan.tickets.filter((t) => t.sinceLast === 'Still open').length,
    scores: current.map((c, i) => ({ name: c.name, before: before[i].score, now: c.score })).filter((s) => s.before !== null || s.now !== null),
  };
}

const change = (before: number | null, now: number | null) =>
  before === null || now === null ? '–' : now > before ? `↑ ${now - before}` : now < before ? `↓ ${before - now}` : 'No change';

export function progressSection(plan: ExportPlan, title: Paragraph): (Paragraph | Table)[] {
  const p = progress(plan);
  if (!p) return [];
  const out: (Paragraph | Table)[] = [
    title,
    para(`Compared with the audit of ${formatDate(plan.previous!.run.startedAt)}.`),
    table(['Fixed since last audit', 'New', 'Still open'], [[String(p.fixed.length), String(p.added), String(p.stillOpen)]], { boldFirstColumn: false }),
    table(
      ['Area', 'Last audit', 'Now', 'Change'],
      p.scores.map((s) => [s.name, s.before === null ? '–' : `${s.before} / 100`, s.now === null ? '–' : `${s.now} / 100`, change(s.before, s.now)]),
      { boldFirstColumn: true },
    ),
  ];
  if (p.fixed.length) {
    out.push(new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: 'Fixed since last time', bold: true })] }));
    for (const f of p.fixed.slice(0, MAX_FIXED)) out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(`${f.title} (${f.ref})`)] }));
    if (p.fixed.length > MAX_FIXED) out.push(para(`And ${p.fixed.length - MAX_FIXED} more.`));
  }
  return out;
}
