// Spec section 4: only free, open-source dependencies with permissive licences.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Zlib', 'Python-2.0']);
/** Allowed by name in the spec, or permissive but not code licences. */
const ALSO_ALLOWED = new Map([
  ['MPL-2.0', 'axe-core: file-level copyleft, allowed by the spec (section 5)'],
  ['CC-BY-4.0', 'caniuse-lite browser data, attribution only (via Crawlee)'],
]);
/** Packages with no licence field whose licence file we have read. */
const CHECKED_BY_HAND = new Map([['map-stream', 'MIT (LICENCE file)']]);

interface LockEntry {
  name?: string;
  license?: string | { type: string } | (string | { type: string })[];
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
}

/** Production packages from package-lock.json, which records each package's licence. */
function productionPackages(): { name: string; licence: string }[] {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, LockEntry> };
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path.includes('node_modules/') && !entry.dev && !entry.devOptional && !entry.link)
    .filter(([path]) => !path.includes('node_modules/@prego/'))
    .map(([path, entry]) => ({ name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13), licence: licenceText(entry.license) }));
}

function licenceText(raw: LockEntry['license']): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return raw.type;
}

function allowed(licence: string): boolean {
  const options = licence.replace(/[()]/g, '').split(/\s+OR\s+/);
  // For "A OR B" one permissive option is enough; for "A AND B" every part must be allowed.
  return options.some((option) => option.split(/\s+AND\s+/).every((part) => PERMISSIVE.has(part) || ALSO_ALLOWED.has(part) || part === 'Apache2'));
}

describe('dependency licences', () => {
  it('every production dependency is permissively licensed', () => {
    const packages = productionPackages();
    expect(packages.length).toBeGreaterThan(50);
    const problems = packages
      .filter(({ name, licence }) => !CHECKED_BY_HAND.has(name) && !allowed(licence))
      .map(({ name, licence }) => `${name}: ${licence || 'no licence field'}`);
    expect(problems).toEqual([]);
  }, 30_000);
});
