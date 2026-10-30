import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const HIGHLIGHT_COLOUR = '#e6007e';

const OVERLAY_ID = '__prego-highlight';
const PAGE_LEVEL_SELECTORS = new Set(['html', 'body', 'head', 'title', 'document']);

export interface CropOptions {
  /** Space around the element. Default 24px. */
  padding?: number;
  /** Smallest crop, so tiny elements keep some context. Default 360 × 200. */
  minWidth?: number;
  minHeight?: number;
  /** Tallest crop; very tall elements are cut off. Default 900px. */
  maxHeight?: number;
}

export async function captureFullPage(page: Page, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
}

/**
 * Screenshot an element with an outline drawn around it and some surrounding context.
 * Page-level findings (selector `html`) get the top of the page, outlined as a whole.
 * Returns false if the element can't be found or has no visible box.
 */
export async function captureCrop(page: Page, selector: string, path: string, options: CropOptions = {}): Promise<boolean> {
  const padding = options.padding ?? 24;
  const minWidth = options.minWidth ?? 360;
  const minHeight = options.minHeight ?? 200;
  const maxHeight = options.maxHeight ?? 900;
  // Page-level findings, and anything in the <head> (titles, meta tags), which has no visible box.
  const pageLevel = PAGE_LEVEL_SELECTORS.has(selector.trim().toLowerCase()) || /^(head|title|meta|link|base)\b/i.test(selector.trim());

  const box = await page
    .evaluate(
      ({ selector, pageLevel, overlayId, colour }) => {
        const doc = document.documentElement;
        let rect: { x: number; y: number; width: number; height: number };
        if (pageLevel) {
          rect = { x: 0, y: 0, width: doc.clientWidth, height: window.innerHeight };
        } else {
          let el: Element | null = document.querySelector(selector);
          // Hidden or zero-size elements (e.g. an <option>) are shown via their nearest visible ancestor.
          while (el && el !== doc) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) break;
            el = el.parentElement;
          }
          if (!el || el === doc) return null;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          rect = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
        }
        // Element outlines sit just outside the element; page-level outlines sit inside the viewport.
        const grow = pageLevel ? 0 : 4;
        const overlay = document.createElement('div');
        overlay.id = overlayId;
        Object.assign(overlay.style, {
          position: 'absolute',
          left: `${rect.x - grow}px`,
          top: `${rect.y - grow}px`,
          width: `${rect.width + grow * 2}px`,
          height: `${rect.height + grow * 2}px`,
          border: `4px solid ${colour}`,
          boxSizing: 'border-box',
          borderRadius: '4px',
          pointerEvents: 'none',
          zIndex: '2147483647',
        });
        document.body.appendChild(overlay);
        return { ...rect, pageWidth: doc.scrollWidth, pageHeight: doc.scrollHeight };
      },
      { selector, pageLevel, overlayId: OVERLAY_ID, colour: HIGHLIGHT_COLOUR },
    )
    .catch(() => null);
  if (!box) return false;

  try {
    const pad = pageLevel ? 0 : padding;
    const width = Math.max(box.width + pad * 2, minWidth);
    const height = Math.min(Math.max(box.height + pad * 2, minHeight), maxHeight);
    const centreX = box.x + box.width / 2;
    const top = box.y - pad;
    const clip = {
      x: clamp(centreX - width / 2, 0, Math.max(0, box.pageWidth - width)),
      y: clamp(top - Math.max(0, (height - box.height - pad * 2) / 2), 0, Math.max(0, box.pageHeight - height)),
      width: Math.min(width, box.pageWidth),
      height: Math.min(height, box.pageHeight),
    };
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, clip, fullPage: true, animations: 'disabled' });
    return true;
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_ID).catch(() => undefined);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
