import type { PregoDb } from '../db/database.js';
import type { Ticket } from '../types.js';

const CLOSED = new Set<Ticket['status']>(['Fixed', 'Dismissed', 'Needs review']);

export interface RunComparison {
  baseRunId: number;
  targetRunId: number;
  /** In the later audit but not the earlier one. */
  added: Ticket[];
  /** In the earlier audit, checked for again in the later one and not found. */
  fixed: Ticket[];
  /** In the later audit after having been fixed before. */
  regressed: Ticket[];
  /** In both. */
  recurring: Ticket[];
  /** In the earlier audit, but the later one didn't run that check, so there's no way to tell. */
  notChecked: Ticket[];
}

/**
 * Compare any two audits of a project: what's new, fixed, back again and still there. An issue
 * counts as fixed only if the later audit ran the check that found it.
 */
export function compareRuns(db: PregoDb, baseRunId: number, targetRunId: number): RunComparison {
  const base = db.getRun(baseRunId);
  const target = db.getRun(targetRunId);
  if (!base || !target) throw new Error('Run not found');
  if (base.projectId !== target.projectId) throw new Error('Both audits must belong to the same project');
  const open = (runId: number) => new Map(db.getTickets(runId).filter((t) => !CLOSED.has(t.status)).map((t) => [t.ticketId, t]));
  const before = open(base.id);
  const after = open(target.id);
  const ranLater = new Set(((target.settings.modules as { id: string }[] | undefined) ?? []).map((m) => m.id));
  const modules = new Map<string, Set<string>>();
  for (const f of db.getRawFindings(base.id)) if (f.ticketId) modules.set(f.ticketId, (modules.get(f.ticketId) ?? new Set()).add(f.module));

  const result: RunComparison = { baseRunId, targetRunId, added: [], fixed: [], regressed: [], recurring: [], notChecked: [] };
  for (const t of after.values()) {
    if (before.has(t.ticketId)) result.recurring.push(t);
    else if (t.status === 'Regressed') result.regressed.push(t);
    else result.added.push(t);
  }
  for (const t of before.values()) {
    if (after.has(t.ticketId)) continue;
    const checked = [...(modules.get(t.ticketId) ?? [])].every((m) => ranLater.has(m));
    (checked ? result.fixed : result.notChecked).push(t);
  }
  const order = (a: Ticket, b: Ticket) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true });
  for (const list of [result.added, result.fixed, result.regressed, result.recurring, result.notChecked]) list.sort(order);
  return result;
}
