import type { Severity } from '../types.js';

// Prego's local copy of public vulnerability data. Audits read the copy, so they never contact a
// vulnerability service, and nothing about an audited site ever leaves the computer.

/** A range of affected versions. Missing bounds are open. */
export interface VersionRange {
  introduced?: string;
  /** First version that isn't affected. */
  fixed?: string;
  /** Last version that is affected. */
  lastAffected?: string;
  /** Only this version. */
  exact?: string;
}

export interface Advisory {
  /** CVE, GHSA or other ID. */
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  /** CVSS base score, when the source gives one. */
  score: number | null;
  url: string;
  ranges: VersionRange[];
  source: 'OSV' | 'NVD';
}

/** One release cycle from endoflife.date. */
export interface EolCycle {
  cycle: string;
  /** Date security support ends (YYYY-MM-DD), true if it has ended without a date, false if not planned. */
  eol: string | boolean;
  latest?: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  url: string;
  licence: string;
  /** When Prego last downloaded it. Null if it never has. */
  fetchedAt: string | null;
  records: number;
  /** Why the last update failed, if it did. The previous copy is kept. */
  error: string | null;
}

export interface VulnDbManifest {
  /** When the last update finished. */
  updatedAt: string | null;
  sources: SourceStatus[];
}

export interface UpdateProgress {
  stage: string;
  done: number;
  total: number;
}
