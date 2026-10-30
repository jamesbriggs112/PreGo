import type { PregoDb } from '../db/database.js';
import { CATEGORIES, CATEGORY_NAMES, type Category, type Location, type Occurrence, type Project, type Run, type Ticket } from '../types.js';

/** Statuses left out of exports: dismissed false positives, and AI suggestions nobody has approved. */
const NOT_EXPORTED = new Set<Ticket['status']>(['Dismissed', 'Needs review']);

export interface PlannedOccurrence extends Occurrence {
  location: Location;
  /** File name in the export's screenshots/ folder, e.g. `PRG-A11Y-014_02.png`, or null if no crop. */
  screenshotFile: string | null;
}

export interface PlannedTicket extends Ticket {
  /** Word report section the ticket appears in, e.g. `4.2`. */
  reportSection: string;
  /** First outlined crop, used in the CSV and the report. */
  screenshotFile: string | null;
  occurrenceList: PlannedOccurrence[];
}

export interface ReportSectionPlan {
  number: string;
  category: Category;
  title: string;
  tickets: PlannedTicket[];
}

/**
 * Everything both exporters need, decided once: which tickets are exported, which report section each
 * one sits in, and the file name of every screenshot. The CSV and Word exporters both read this, so
 * their cross-references always agree.
 */
export interface ExportPlan {
  project: Project;
  run: Run;
  previousRun: Run | undefined;
  locations: Location[];
  sections: ReportSectionPlan[];
  tickets: PlannedTicket[];
  /** Screenshot file name in the export → source path relative to the run folder. */
  screenshots: Map<string, string>;
}

/** Section 4 of the report holds findings; each category with tickets gets a subsection. */
export const FINDINGS_SECTION = 4;

export function buildExportPlan(db: PregoDb, runId: number): ExportPlan {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const project = db.getProject(run.projectId)!;
  const locations = db.getLocations(runId);
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const screenshots = new Map<string, string>();

  const exported = db
    .getTickets(runId)
    .filter((t) => !NOT_EXPORTED.has(t.status))
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId, 'en', { numeric: true }));

  const sections: ReportSectionPlan[] = [];
  for (const category of CATEGORIES) {
    const inCategory = exported.filter((t) => t.category === category);
    if (inCategory.length === 0) continue;
    const number = `${FINDINGS_SECTION}.${sections.length + 1}`;
    const planned = inCategory.map((ticket): PlannedTicket => {
      let n = 0;
      const occurrenceList = db.getOccurrences(runId, ticket.ticketId).map((occurrence): PlannedOccurrence => {
        let screenshotFile: string | null = null;
        if (occurrence.crop) {
          screenshotFile = `${ticket.ticketId}_${String(++n).padStart(2, '0')}.png`;
          screenshots.set(screenshotFile, occurrence.crop);
        }
        return { ...occurrence, location: locationById.get(occurrence.locationId)!, screenshotFile };
      });
      return {
        ...ticket,
        reportSection: number,
        screenshotFile: occurrenceList.find((o) => o.screenshotFile)?.screenshotFile ?? null,
        occurrenceList,
      };
    });
    sections.push({ number, category, title: CATEGORY_NAMES[category], tickets: planned });
  }

  return {
    project,
    run,
    previousRun: db.previousRun(runId),
    locations,
    sections,
    tickets: sections.flatMap((s) => s.tickets),
    screenshots,
  };
}
