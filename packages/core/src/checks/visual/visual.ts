import { readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { CheckFactoryContext } from '../registry.js';
import type { CheckFinding, CheckModule } from '../types.js';
import { guidanceFor } from '../guidance.js';

// Each page's screenshot compared with the same page in the project's previous audit, using
// pixelmatch. Small differences (anti-aliasing, a changed date) are ignored.

/** Share of pixels that must change before a page is reported. */
const MIN_CHANGED = 0.01;
const MAX_EVIDENCE_HEIGHT = 2000;

export interface VisualDiff {
  /** Share of the overlapping area that changed, 0–1. */
  changed: number;
  heightBefore: number;
  heightAfter: number;
  /** The changed area, with differences in red, as a PNG. */
  image: Buffer | null;
  /** Where the changes are, in page pixels. */
  box: { top: number; bottom: number } | null;
}

/** Compare two full-page screenshots. Exported for tests. */
export function compareScreenshots(before: Buffer, after: Buffer): VisualDiff | null {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  // A different window width means a different viewport, not a change to the page.
  if (a.width !== b.width) return null;
  const width = a.width;
  const height = Math.min(a.height, b.height);
  const crop = (png: PNG) => (png.height === height ? png.data : png.data.subarray(0, width * height * 4));
  const diff = new PNG({ width, height });
  const count = pixelmatch(crop(a), crop(b), diff.data, width, height, { threshold: 0.1, includeAA: false, alpha: 0.2 });

  // Rows that changed, for the evidence image and the description.
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height && count; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  let image: Buffer | null = null;
  if (top >= 0) {
    const from = Math.max(0, top - 20);
    const to = Math.min(height, bottom + 20, from + MAX_EVIDENCE_HEIGHT);
    const evidence = new PNG({ width, height: to - from });
    diff.data.copy(evidence.data, 0, from * width * 4, to * width * 4);
    image = PNG.sync.write(evidence);
  }
  return { changed: count / (width * height), heightBefore: a.height, heightAfter: b.height, image, box: top >= 0 ? { top, bottom } : null };
}

export function visualModule(context: Pick<CheckFactoryContext, 'previousScreenshot'> = {}): CheckModule {
  return {
    id: 'visual',
    name: 'Changes since the last audit',
    async run({ location, viewport, screenshot }) {
      const previous = context.previousScreenshot?.(location, viewport);
      if (!previous || !screenshot) return [];
      const diff = compareScreenshots(readFileSync(previous.path), readFileSync(screenshot));
      if (!diff) return [];
      const grew = diff.heightAfter - diff.heightBefore;
      const resized = Math.abs(grew) > Math.max(50, diff.heightBefore * 0.1);
      if (diff.changed < MIN_CHANGED && !resized) return [];
      const parts = [`About ${Math.max(1, Math.round(diff.changed * 100))}% of the page looks different from the audit on ${previous.date}`];
      if (diff.box) parts.push(`, mostly between ${diff.box.top}px and ${diff.box.bottom}px from the top`);
      parts.push('.');
      if (resized) parts.push(` The page is ${Math.abs(grew)}px ${grew > 0 ? 'taller' : 'shorter'}.`);
      return [finding(parts.join(''), diff.changed >= 0.25 || resized, location.url, diff.image)];
    },
  };
}

function finding(failureSummary: string, large: boolean, url: string, image: Buffer | null): CheckFinding {
  const guidance = guidanceFor('prego', 'visual-change')!;
  return {
    module: 'visual',
    engine: 'prego',
    ruleId: 'visual-change',
    category: 'UI',
    severity: large ? 'Medium' : 'Low',
    title: guidance.title,
    description: guidance.description,
    helpUrl: null,
    wcagCriteria: [],
    wcagLevel: null,
    selector: 'html',
    html: '<html>',
    failureSummary,
    component: `visual:${new URL(url).pathname}`,
    ...(image && { cropImage: image }),
  };
}
