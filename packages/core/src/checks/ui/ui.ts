import type { Severity } from '../../types.js';
import type { CheckModule, LocatedFinding } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Visual consistency across the whole site: which colours, typefaces, sizes and spacing are actually
// used, and where near-duplicates suggest values were picked by eye rather than from a design system.

type Kind = 'colour' | 'font-family' | 'font-size' | 'line-height' | 'spacing';

/** One value seen on a page, with an example element. */
interface Sample {
  kind: Kind;
  value: string;
  count: number;
  selector: string;
  html: string;
}

interface Seen {
  value: string;
  count: number;
  /** First place each value was seen. */
  example: { locationId: number; viewport: string; selector: string; html: string; url: string };
}

export interface UiConsistencyOptions {
  /** Colours closer than this (CIE76 ΔE) are near-duplicates. Default 3. */
  colourDistance?: number;
  /** More distinct greys than this is flagged. Default 8. */
  maxGreys?: number;
  /** More font families than this is flagged. Default 3. */
  maxFontFamilies?: number;
  /** More distinct font sizes than this is flagged. Default 10. */
  maxFontSizes?: number;
}

export function uiConsistencyModule(options: UiConsistencyOptions = {}): CheckModule {
  const seen = new Map<Kind, Map<string, Seen>>();
  return {
    id: 'ui',
    name: 'UI consistency',
    perViewport: false,
    async run({ page, location, viewport }) {
      const samples = await page.evaluate(collect);
      for (const sample of samples) {
        const byValue = seen.get(sample.kind) ?? new Map<string, Seen>();
        const entry = byValue.get(sample.value);
        if (entry) entry.count += sample.count;
        else byValue.set(sample.value, { value: sample.value, count: sample.count, example: { locationId: location.id, viewport, selector: sample.selector, html: sample.html, url: location.url } });
        seen.set(sample.kind, byValue);
      }
      return [];
    },
    async finish() {
      return analyse(seen, options);
    },
  };
}

/** Runs in the page: every visible element's colours, type and spacing, counted by value. */
function collect(): Sample[] {
  const MAX = 4000;
  const samples = new Map<string, Sample>();
  const path = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
    }
    return parts.join(' > ');
  };
  const add = (kind: Sample['kind'], value: string, el: Element) => {
    const key = `${kind}|${value}`;
    const existing = samples.get(key);
    if (existing) existing.count++;
    else samples.set(key, { kind, value, count: 1, selector: path(el), html: el.outerHTML.replace(/>[\s\S]*$/, '>').slice(0, 200) });
  };
  // Chromium's own styles for form controls: not choices the site made, so not drift.
  const CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const UA_CONTROL_VALUES = new Set(['13.3333px', 'rgb(239, 239, 239)', 'rgb(118, 118, 118)', 'rgb(133, 133, 133)', 'rgb(0, 0, 0)']);
  const authored = (el: Element, value: string) => !(CONTROLS.has(el.tagName) && UA_CONTROL_VALUES.has(value));
  const hasOwnText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
  for (const el of [...document.body.querySelectorAll('*')].slice(0, MAX)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    if (hasOwnText(el)) {
      if (authored(el, s.color)) add('colour', s.color, el);
      add('font-family', s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''), el);
      if (authored(el, s.fontSize)) add('font-size', s.fontSize, el);
      const size = parseFloat(s.fontSize);
      const line = s.lineHeight === 'normal' ? NaN : parseFloat(s.lineHeight);
      if (size && !Number.isNaN(line)) add('line-height', (line / size).toFixed(2), el);
    }
    if (!/rgba\(.*,\s*0\)$|transparent/.test(s.backgroundColor) && authored(el, s.backgroundColor)) add('colour', s.backgroundColor, el);
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && authored(el, s.borderTopColor)) add('colour', s.borderTopColor, el);
    if (CONTROLS.has(el.tagName)) continue;
    for (const prop of ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft', 'gap'] as const) {
      const v = parseFloat(s[prop] as string);
      // Whole pixels of 4 or more: hairlines and em-derived fractions are browser maths, not choices.
      if (v >= 4 && Math.abs(v - Math.round(v)) < 0.01) add('spacing', `${v}px`, el);
    }
  }
  return [...samples.values()];
}

function analyse(seen: Map<Kind, Map<string, Seen>>, options: UiConsistencyOptions): LocatedFinding[] {
  const out: LocatedFinding[] = [];
  const all = (kind: Kind) => [...(seen.get(kind)?.values() ?? [])].sort((a, b) => b.count - a.count);

  // Near-duplicate colours, clustered around the most-used value.
  const colours = all('colour')
    .map((c) => ({ ...c, rgb: parseColour(c.value) }))
    .filter((c): c is Seen & { rgb: [number, number, number] } => c.rgb !== null);
  const distance = options.colourDistance ?? 3;
  for (const cluster of clusters(colours, (a, b) => deltaE(lab(a.rgb), lab(b.rgb)) < distance)) {
    out.push(drift('colour-near-duplicates', 'Medium', `colours:${hex(cluster[0].rgb)}`, cluster, (c) => hex(c.rgb), 'colours that look almost the same'));
  }
  // Pure white and black are part of any palette, so they don't count towards the greys.
  const greys = colours.filter((c) => Math.max(...c.rgb) - Math.min(...c.rgb) <= 8 && !['#ffffff', '#000000'].includes(hex(c.rgb)));
  if (greys.length > (options.maxGreys ?? 8)) {
    out.push(drift('too-many-greys', 'Low', 'greys', greys, (c) => hex(c.rgb), 'shades of grey'));
  }

  const families = all('font-family');
  if (families.length > (options.maxFontFamilies ?? 3)) out.push(drift('too-many-fonts', 'Medium', 'font-families', families, (f) => f.value, 'typefaces'));

  const sizes = all('font-size').map((s) => ({ ...s, px: parseFloat(s.value) }));
  for (const cluster of clusters(sizes, (a, b) => a.px !== b.px && Math.abs(a.px - b.px) <= 1.01)) {
    out.push(drift('font-size-near-duplicates', 'Low', `font-sizes:${cluster[0].value}`, cluster, (s) => s.value, 'text sizes a pixel or less apart'));
  }
  if (sizes.length > (options.maxFontSizes ?? 10)) out.push(drift('too-many-font-sizes', 'Low', 'font-sizes', sizes, (s) => s.value, 'text sizes'));

  const lines = all('line-height').map((l) => ({ ...l, ratio: parseFloat(l.value) }));
  for (const cluster of clusters(lines, (a, b) => a.ratio !== b.ratio && Math.abs(a.ratio - b.ratio) <= 0.05)) {
    out.push(drift('line-height-near-duplicates', 'Low', `line-heights:${cluster[0].value}`, cluster, (l) => `${l.value}×`, 'line heights that differ by a hair'));
  }

  const spacing = all('spacing').map((s) => ({ ...s, px: parseFloat(s.value) }));
  for (const cluster of clusters(spacing, (a, b) => a.px !== b.px && Math.abs(a.px - b.px) <= 1)) {
    out.push(drift('spacing-near-duplicates', 'Low', `spacing:${cluster[0].value}`, cluster, (s) => s.value, 'spacing values a pixel apart'));
  }
  return out;
}

/** Group values that are close to the most-used value of each group. Only groups of two or more. */
function clusters<T extends Seen>(values: T[], close: (a: T, b: T) => boolean): T[][] {
  const left = [...values];
  const groups: T[][] = [];
  while (left.length) {
    const anchor = left.shift()!;
    const group = [anchor, ...left.filter((v) => close(anchor, v))];
    for (const v of group.slice(1)) left.splice(left.indexOf(v), 1);
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

function drift<T extends Seen>(ruleId: string, severity: Severity, component: string, values: T[], show: (v: T) => string, noun: string): LocatedFinding {
  const guidance = guidanceFor('prego', ruleId)!;
  // Report it where the least-used variant appears: that's usually the odd one out to change.
  const odd = [...values].sort((a, b) => a.count - b.count)[0];
  const list = values.map((v) => `${show(v)} (used ${v.count} ${v.count === 1 ? 'time' : 'times'}, e.g. ${new URL(v.example.url).pathname})`).join('; ');
  return {
    module: 'ui',
    engine: 'prego',
    ruleId,
    category: 'UI',
    severity,
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: odd.example.selector,
    html: odd.example.html,
    failureSummary: `${values.length} ${noun}: ${list}.`,
    siteWide: true,
    component,
    locationId: odd.example.locationId,
    viewport: odd.example.viewport,
  };
}

/** rgb()/rgba() → [r, g, b], or null for transparent and anything unparseable. */
export function parseColour(value: string): [number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** sRGB → CIE L*a*b* (D65). */
export function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference: under about 2 is barely noticeable, under 5 reads as "the same colour". */
export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

