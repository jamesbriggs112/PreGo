import type { PregoDb, TicketOverride } from '../db/database.js';
import type { Priority, Severity, Ticket } from '../types.js';
import { buildTickets } from './build.js';

/** What an auditor can change on a ticket. `null` resets a field to the computed value. */
export interface TicketChanges {
  title?: string | null;
  severity?: Severity | null;
  priority?: Priority | null;
  auditorNotes?: string | null;
  dismissed?: boolean;
}

export class TriageError extends Error {}

/**
 * Save an auditor's changes to a ticket. They're stored for the project, so they also apply to the
 * same ticket in later runs, and the run's tickets are rebuilt so exports pick them up straight away.
 */
export function updateTicket(db: PregoDb, runId: number, ticketId: string, changes: TicketChanges): Ticket {
  const run = requireTicket(db, runId, ticketId);
  const override: Partial<TicketOverride> = {};
  if (changes.title !== undefined) override.title = changes.title?.trim() || null;
  if (changes.severity !== undefined) override.severity = changes.severity;
  if (changes.priority !== undefined) override.priority = changes.priority;
  if (changes.auditorNotes !== undefined) override.auditorNotes = changes.auditorNotes;
  if (changes.dismissed !== undefined) override.dismissed = changes.dismissed;
  db.transaction(() => {
    db.saveOverride(run.projectId, ticketId, override);
    rebuild(db, runId);
  });
  return db.getTicket(runId, ticketId)!;
}

/**
 * Merge tickets into one: their occurrences move to `intoTicketId` and they disappear from this run.
 * The merge is stored for the project, so later runs keep them together. Merged-away IDs are never
 * reused.
 */
export function mergeTickets(db: PregoDb, runId: number, intoTicketId: string, fromTicketIds: string[]): Ticket {
  const run = requireTicket(db, runId, intoTicketId);
  const into = db.getTicket(runId, intoTicketId)!;
  const from = [...new Set(fromTicketIds)].filter((id) => id !== intoTicketId);
  if (from.length === 0) throw new TriageError('Choose at least one other ticket to merge.');
  for (const id of from) {
    const ticket = db.getTicket(runId, id);
    if (!ticket) throw new TriageError(`Ticket ${id} is not in this run.`);
    if (ticket.category !== into.category) throw new TriageError(`Only tickets in the same category can be merged (${id} is ${ticket.category}, ${intoTicketId} is ${into.category}).`);
  }
  db.transaction(() => {
    for (const id of from) db.addMerge(run.projectId, id, intoTicketId);
    rebuild(db, runId);
  });
  return db.getTicket(runId, intoTicketId)!;
}

function requireTicket(db: PregoDb, runId: number, ticketId: string) {
  const run = db.getRun(runId);
  if (!run) throw new TriageError(`Run ${runId} not found.`);
  if (!db.getTicket(runId, ticketId)) throw new TriageError(`Ticket ${ticketId} is not in this run.`);
  return run;
}

function rebuild(db: PregoDb, runId: number) {
  const run = db.getRun(runId)!;
  buildTickets(db, runId, { keyJourneyUrls: (run.settings.keyJourneyUrls as string[] | undefined) ?? [] });
}
