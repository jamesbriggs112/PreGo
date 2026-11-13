import { SEVERITIES, type Severity } from '../types.js';
import { AXE_EQUIVALENT } from '../checks/ibm/ibm-guidance.js';
import type { ExportPlan, PlannedTicket } from './plan.js';
import { auditedCount } from './docx.js';
import { fixMetaFor, largerEffort, type Area, type Effort, type FixMeta, type Impact, type Owner } from './fix-meta.js';

// The action plan: what to fix, in what order, who does it and how big a job it is. One row per
// distinct issue: a check failing in one area of the site (the header, the forms, the page templates).

export type PlanGroup = 'Quick wins' | 'Plan next' | 'When you can';
export const PLAN_GROUPS: PlanGroup[] = ['Quick wins', 'Plan next', 'When you can'];

export interface PlanRow {
  fix: string;
  /** Where on the site, in words: "Site header, every page (135)". */
  where: string;
  area: Area;
  who: Owner;
  effort: Effort;
  impact: Impact;
  reason: string;
  /** Short references to the tickets, e.g. "A11Y-002". */
  refs: string[];
  severity: Severity;
  pages: number;
  advisory: boolean;
  affects: string[];
  check: string | null;
  group: PlanGroup;
  score: number;
  tickets: PlannedTicket[];
  meta: FixMeta;
}

/** A ticket's short reference for client documents: PRG-A11Y-003 → A11Y-003. */
export const shortRef = (ticketId: string) => ticketId.replace(/^PRG-/, '');

/** The location label from a ticket's title, in plain words: "Site header, every page". */
export function whereLabel(t: Pick<PlannedTicket, 'title'>): string {
  const label = /\(([^)]*)\)$/.exec(t.title)?.[1] ?? '';
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}

export function actionPlan(plan: Pick<ExportPlan, 'tickets' | 'locations'>): PlanRow[] {
  const audited = auditedCount(plan as ExportPlan) || 1;
  const groups = new Map<string, { tickets: PlannedTicket[]; metas: FixMeta[] }>();
  for (const t of plan.tickets) {
    const meta = fixMetaFor(t, audited);
    // Busy pages, a persona it's a barrier for, or a task it stops, move it up (see cross.ts).
    meta.score *=
      (1 + 2 * (t.traffic ?? 0)) * (1 + 0.5 * (t.impact?.barrierFor.length ?? 0)) * (t.impact?.blocksTaskIds.length ? 1.5 : 1) * (1 + 0.25 * (t.impact?.purposeIds.length ?? 0));
    const key = `${AXE_EQUIVALENT[t.ruleId] ?? t.ruleId}|${meta.area}`;
    const g = groups.get(key) ?? { tickets: [], metas: [] };
    g.tickets.push(t);
    g.metas.push(meta);
    groups.set(key, g);
  }
  const rows: PlanRow[] = [];
  for (const { tickets, metas } of groups.values()) {
    const worst = tickets.reduce((a, b) => (SEVERITIES.indexOf(b.severity) < SEVERITIES.indexOf(a.severity) ? b : a));
    const meta = metas[tickets.indexOf(worst)];
    const pages = Math.min(
      audited,
      tickets.reduce((n, t) => n + t.locationsAffected, 0),
    );
    const effort = meta.owner === 'Content editor' ? metas.reduce((e, m) => largerEffort(e, m.effort), meta.effort) : meta.effort;
    const impact = metas.some((m) => m.impact === 'High') ? 'High' : metas.some((m) => m.impact === 'Medium') ? 'Medium' : 'Low';
    const advisory = metas.every((m) => m.advisory);
    const labels = [...new Set(tickets.map(whereLabel).filter(Boolean))];
    const where =
      tickets.length === 1 || labels.length === 1
        ? `${labels[0] ?? meta.area}${pages > 1 ? ` (${pages} pages)` : ''}`
        : `${meta.area}: ${labels.slice(0, 2).join('; ')}${labels.length > 2 ? ` and ${labels.length - 2} more` : ''} (${pages} ${pages === 1 ? 'page' : 'pages'})`;
    const group: PlanGroup = advisory || impact === 'Low' ? 'When you can' : impact === 'High' && (effort === 'Quick' || effort === 'Small') ? 'Quick wins' : 'Plan next';
    rows.push({
      fix: meta.action,
      where,
      area: meta.area,
      who: meta.owner,
      effort,
      impact,
      reason: meta.reason,
      refs: tickets.map((t) => shortRef(t.ticketId)),
      severity: worst.severity,
      pages,
      advisory,
      affects: [...new Set(metas.flatMap((m) => m.affects))],
      check: meta.check,
      group,
      score: Math.max(...metas.map((m) => m.score)),
      tickets,
      meta,
    });
  }
  return rows.sort(
    (a, b) =>
      PLAN_GROUPS.indexOf(a.group) - PLAN_GROUPS.indexOf(b.group) || b.score - a.score || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.pages - a.pages,
  );
}
