import type { PregoDb } from '../db/database.js';
import type { Location, Project, RawFinding, Run } from '../types.js';

/** The parts of an export's run.json needed to rebuild its tickets. */
export interface RunJson {
  project: Pick<Project, 'name'>;
  run: Pick<Run, 'mode' | 'target' | 'settings' | 'summary'>;
  locations: Location[];
  rawFindings: RawFinding[];
}

/**
 * Load an exported run.json into a database as a new run, so its tickets and scores can be rebuilt
 * with the current rules without crawling the site again. Used to check accuracy changes against real
 * audits. Screenshots aren't restored. Returns the new run's ID.
 */
export function restoreRun(db: PregoDb, json: RunJson, projectName = json.project.name): number {
  const project = db.ensureProject(projectName);
  const run = db.createRun({ projectId: project.id, mode: json.run.mode, target: json.run.target, settings: json.run.settings });
  db.transaction(() => {
    const ids = new Map<number, number>();
    for (const l of json.locations) {
      const added = db.addLocation({
        runId: run.id,
        kind: l.kind,
        url: l.url,
        stateId: l.stateId,
        title: l.title,
        statusCode: l.statusCode,
        depth: l.depth,
        templateKey: l.templateKey,
        structureHash: l.structureHash,
        audited: l.audited,
        notAuditedReason: l.notAuditedReason,
        steps: l.steps,
      });
      db.updateLocation(added.id, { metrics: l.metrics });
      ids.set(l.id, added.id);
    }
    for (const f of json.rawFindings) {
      const { id: _id, fingerprint: _fp, ticketId: _ticket, crop: _crop, ...rest } = f;
      const locationId = ids.get(f.locationId);
      if (locationId !== undefined) db.addRawFinding({ ...rest, runId: run.id, locationId });
    }
  });
  db.finishRun(run.id, 'complete', json.run.summary);
  return run.id;
}
