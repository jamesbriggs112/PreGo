import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

/**
 * The page's DOM structure as a set of element paths (tags and classes, ignoring text and other
 * attributes), e.g. `body>header.site-header>nav>a`. Classes containing digits are dropped because
 * they're usually IDs or state (`post-123`, `col-4`), not template structure.
 */
export async function extractStructure(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'IFRAME']);
    const MAX_DEPTH = 14;
    const paths = new Set<string>();
    const sig = (el: Element) => {
      const classes = [...el.classList].filter((c) => !/\d/.test(c)).sort();
      return el.tagName.toLowerCase() + (classes.length ? '.' + classes.join('.') : '');
    };
    const walk = (el: Element, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      for (const child of el.children) {
        if (SKIP.has(child.tagName)) continue;
        const path = `${prefix}>${sig(child)}`;
        paths.add(path);
        walk(child, path, depth + 1);
      }
    };
    walk(document.body, 'body', 0);
    return [...paths].sort();
  });
}

export function structureHash(structure: string[]): string {
  return createHash('sha1').update([...structure].sort().join('\n')).digest('hex').slice(0, 16);
}

/** Share of element paths two pages have in common (Jaccard similarity), 0 to 1. */
export function similarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const path of setA) if (setB.has(path)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 1 : shared / union;
}

export interface TemplatePage {
  url: string;
  depth: number;
  structure: string[];
}

export interface TemplateGroup<P extends TemplatePage = TemplatePage> {
  /** Stable, readable key derived from member URLs, e.g. `/news/*`. Used in ticket fingerprints. */
  key: string;
  /** Hash of the first member's structure. */
  hash: string;
  pages: P[];
}

export interface GroupOptions {
  /** Minimum similarity for a page to join a template. Default 0.8. */
  threshold?: number;
}

/**
 * Group pages that share a template. Pages are visited in a fixed order and each joins the first
 * group whose first page is similar enough, so the same site always groups the same way.
 */
export function groupTemplates<P extends TemplatePage>(pages: P[], options: GroupOptions = {}): TemplateGroup<P>[] {
  const threshold = options.threshold ?? 0.8;
  const ordered = [...pages].sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  const groups: { first: P; pages: P[] }[] = [];
  for (const page of ordered) {
    const group = groups.find((g) => similarity(g.first.structure, page.structure) >= threshold);
    if (group) group.pages.push(page);
    else groups.push({ first: page, pages: [page] });
  }
  return groups.map((g) => ({ key: templateKey(g.pages.map((p) => p.url)), hash: structureHash(g.first.structure), pages: g.pages }));
}

/**
 * A URL pattern covering every member: `/about.html` for one page, `/news/*` for pages differing in
 * the last segment, `/shop/**` when the paths only share a prefix.
 */
export function templateKey(urls: string[]): string {
  const split = urls.map((url) => new URL(url).pathname.split('/').filter(Boolean));
  if (split.length === 1) return '/' + split[0].join('/');
  const sameLength = split.every((s) => s.length === split[0].length);
  if (sameLength) {
    return '/' + split[0].map((segment, i) => (split.every((s) => s[i] === segment) ? segment : '*')).join('/');
  }
  const prefix: string[] = [];
  for (let i = 0; split.every((s) => i < s.length && s[i] === split[0][i]); i++) prefix.push(split[0][i]);
  return '/' + [...prefix, '**'].join('/');
}

export interface SampledPage<P extends TemplatePage> {
  page: P;
  templateKey: string;
  templateHash: string;
  audit: boolean;
  /** Why the page isn't being audited, when `audit` is false. */
  reason?: string;
}

/** Choose which pages to audit: the first `perTemplate` pages of each template, or all of them. */
export function samplePages<P extends TemplatePage>(
  groups: TemplateGroup<P>[],
  options: { perTemplate?: number; auditAll?: boolean } = {},
): SampledPage<P>[] {
  const perTemplate = options.perTemplate ?? 3;
  return groups.flatMap((group) =>
    group.pages.map((page, i) => {
      const audit = options.auditAll || i < perTemplate;
      return {
        page,
        templateKey: group.key,
        templateHash: group.hash,
        audit,
        reason: audit ? undefined : `Same template as ${group.pages[0].url} (${group.key}); not audited`,
      };
    }),
  );
}
