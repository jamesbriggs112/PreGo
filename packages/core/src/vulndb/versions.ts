import type { VersionRange } from './types.js';

/** Compares dotted versions part by part, numbers numerically: 1.10 > 1.9, 1.0.2k > 1.0.2. Pre-releases (1.0.0-rc1) sort before the release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/i, '').split(/-(.*)/s);
    return { parts: main.split(/[.+]/).flatMap((p) => p.match(/\d+|[a-z]+/gi) ?? []), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const p = x.parts[i] ?? '0';
    const q = y.parts[i] ?? '0';
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    const diff = numeric ? Number(p) - Number(q) : p.localeCompare(q);
    if (diff) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** Whether a version is in any of the ranges. */
export function affected(version: string, ranges: VersionRange[]): boolean {
  return ranges.some((r) => {
    if (r.exact) return compareVersions(version, r.exact) === 0;
    if (r.introduced && r.introduced !== '0' && compareVersions(version, r.introduced) < 0) return false;
    if (r.fixed) return compareVersions(version, r.fixed) < 0;
    if (r.lastAffected) return compareVersions(version, r.lastAffected) <= 0;
    // An open range with no upper bound only counts when it has a lower bound.
    return !!r.introduced;
  });
}
