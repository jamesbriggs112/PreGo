import { chromium } from 'playwright';
import { layoutStateMap, NODE_HEIGHT, NODE_WIDTH, type MapEdge, type MapState } from '../explore/layout.js';

export interface ImageState extends MapState {
  issues: number;
  /** Drawn with a thick red border: a usability problem of its own. */
  flagged: boolean;
}

const PADDING = 24;

/** The state map as an SVG: columns are taps from the start, lines the first route to each screen. */
export function stateMapSvg(states: ImageState[], edges: MapEdge[]): string {
  const layout = layoutStateMap(states, edges);
  const info = new Map(states.map((s) => [s.id, s]));
  const position = new Map(layout.states.map((s) => [s.id, s]));
  const width = layout.width + PADDING * 2;
  const height = layout.height + PADDING * 2 + 28;

  const links = layout.links
    .filter((l) => l.tree)
    .map((l) => {
      const a = position.get(l.from)!;
      const b = position.get(l.to)!;
      const x1 = a.x + NODE_WIDTH + PADDING;
      const y1 = a.y + NODE_HEIGHT / 2 + PADDING;
      const x2 = b.x + PADDING;
      const y2 = b.y + NODE_HEIGHT / 2 + PADDING;
      const mid = (x1 + x2) / 2;
      return `<path d="M${x1},${y1} H${mid} V${y2} H${x2 - 6}" fill="none" stroke="#7a8696" stroke-width="1.5" marker-end="url(#arrow)"/>`;
    })
    .join('');

  const nodes = layout.states
    .map((s) => {
      const state = info.get(s.id)!;
      const x = s.x + PADDING;
      const y = s.y + PADDING;
      const border = state.flagged ? '#c0262d' : '#9aa5b1';
      const detail = `${s.depth} ${s.depth === 1 ? 'tap' : 'taps'} · ${state.issues} ${state.issues === 1 ? 'issue' : 'issues'}`;
      return `<g>
        <rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" fill="#ffffff" stroke="${border}" stroke-width="${state.flagged ? 3 : 1.5}"/>
        <text x="${x + 12}" y="${y + 26}" font-size="14" font-weight="700" fill="#1b2430">${escape(truncate(s.title, 24))}</text>
        <text x="${x + 12}" y="${y + 46}" font-size="12" fill="#4b5563">${escape(detail)}</text>
      </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7a8696"/></marker></defs>
    <rect width="100%" height="100%" fill="#f5f7fa"/>
    ${links}${nodes}
    <text x="${PADDING}" y="${height - 12}" font-size="12" fill="#4b5563">Columns: taps from the start screen. Lines: the first route to each screen. Thick red border: a dead end or a control that does nothing.</text>
  </svg>`;
}

/** Render the state map to a PNG with headless Chromium. */
export async function stateMapPng(states: ImageState[], edges: MapEdge[]): Promise<Buffer> {
  return svgToPng(stateMapSvg(states, edges));
}

/** Draw an SVG to a PNG at twice its size, for sharp images in the Word report. */
export async function svgToPng(svg: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    return await page.locator('svg').screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
