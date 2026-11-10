import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Advisory, EolCycle, VulnDbManifest } from './types.js';
import { affected, compareVersions } from './versions.js';

// The vulnerability data on disk, in the data folder's vulndb/ (so the app can refresh it without
// writing to its own files), and the lookups audits use.

export const vulnDbDir = (dataDir: string) => join(dataDir, 'vulndb');
export const FILES = { manifest: 'manifest.json', retire: 'retire.json', advisories: 'advisories.json', kev: 'kev.json', eol: 'eol.json' } as const;

/** Write a file in one step, so an audit never reads half of one. */
export function writeJson(dataDir: string, file: string, value: unknown) {
  const dir = vulnDbDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

export function readJson<T>(dataDir: string, file: string): T | null {
  const path = join(vulnDbDir(dataDir), file);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readManifest(dataDir: string): VulnDbManifest | null {
  return readJson<VulnDbManifest>(dataDir, FILES.manifest);
}

/** Age of the data in days, or null when there isn't any. */
export function vulnDbAgeDays(dataDir: string, now = Date.now()): number | null {
  const updated = readManifest(dataDir)?.updatedAt;
  return updated ? Math.floor((now - Date.parse(updated)) / 86_400_000) : null;
}

export interface EolStatus {
  cycle: string;
  /** Date support ended, or null when the source doesn't give one. */
  endedOn: string | null;
  latest?: string;
}

export interface VulnDb {
  /** When the data was last updated (ISO), or null for the copy bundled with Prego. */
  date: string | null;
  /** Path to the Retire.js database to use. */
  retirePath: string | null;
  /** Advisories affecting a version, worst first. `key` is a software ID or `npm:<package>`. */
  advisoriesFor(key: string, version: string): Advisory[];
  /** The release cycle the version belongs to, if its security support has ended. */
  endOfLife(product: string, version: string, today?: string): EolStatus | null;
  /** Which of these IDs are known to be exploited (CISA KEV). */
  exploited(ids: string[]): string[];
}

const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 } as const;

const cache = new Map<string, { mtime: number; db: VulnDb }>();

/** The local data, read once and kept until it's updated. Empty lookups when there's none. */
export function openVulnDb(dataDir: string): VulnDb {
  const manifestPath = join(vulnDbDir(dataDir), FILES.manifest);
  const mtime = existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : 0;
  const cached = cache.get(dataDir);
  if (cached && cached.mtime === mtime) return cached.db;

  const advisories = readJson<Record<string, Advisory[]>>(dataDir, FILES.advisories) ?? {};
  const kev = new Set(readJson<string[]>(dataDir, FILES.kev) ?? []);
  const eol = readJson<Record<string, EolCycle[]>>(dataDir, FILES.eol) ?? {};
  const retirePath = join(vulnDbDir(dataDir), FILES.retire);
  // Worst first: by severity, then by CVSS score within a severity.
  const rank = (a: Advisory) => SEVERITY_RANK[a.severity] * 100 + (a.score ?? 0);
  const db: VulnDb = {
    date: readManifest(dataDir)?.updatedAt ?? null,
    retirePath: existsSync(retirePath) ? retirePath : null,
    advisoriesFor: (key, version) => (advisories[key] ?? []).filter((a) => affected(version, a.ranges)).sort((a, b) => rank(b) - rank(a)),
    endOfLife(product, version, today = new Date().toISOString().slice(0, 10)) {
      // The longest cycle the version starts with: "8.1" for 8.1.2, "6" for 6.4 when cycles are majors.
      const cycle = (eol[product] ?? [])
        .filter((c) => version === c.cycle || version.startsWith(`${c.cycle}.`))
        .sort((a, b) => b.cycle.length - a.cycle.length)[0];
      if (!cycle) return null;
      const ended = cycle.eol === true || (typeof cycle.eol === 'string' && cycle.eol <= today);
      if (!ended) return null;
      return { cycle: cycle.cycle, endedOn: typeof cycle.eol === 'string' ? cycle.eol : null, latest: cycle.latest };
    },
    exploited: (ids) => [...new Set(ids)].filter((id) => kev.has(id)),
  };
  cache.set(dataDir, { mtime, db });
  return db;
}

export { compareVersions };
