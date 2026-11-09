import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { SharingMetrics } from '../checks/sharing/sharing.js';

// Pictures of how a page appears in a search result and when its link is shared, drawn from the
// page's own tags in the style of each platform. Approximations to show the client what people see,
// not screenshots of the platforms.

export interface PreviewPage {
  url: string;
  sharing: SharingMetrics;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

function imageUri(sharing: SharingMetrics, runDir: string): string | null {
  const file = sharing.image?.file;
  if (!file || !existsSync(join(runDir, file))) return null;
  const type = file.endsWith('.png') ? 'png' : file.endsWith('.webp') ? 'webp' : 'jpeg';
  return `data:image/${type};base64,${readFileSync(join(runDir, file)).toString('base64')}`;
}

/** The preview panel for one page, as HTML. Exported for tests. */
export function previewHtml(page: PreviewPage, image: string | null): string {
  const s = page.sharing;
  const url = new URL(page.url);
  const host = url.hostname.replace(/^www\./, '');
  const crumbs = [host, ...url.pathname.split('/').filter(Boolean).map((p) => p.replace(/\.html?$/, ''))].join(' › ');
  const title = s.og.title ?? s.title;
  const description = s.og.description ?? s.description;
  const missing = (text: string) => `<span class="missing">${esc(text)}</span>`;
  const picture = (cls: string) => (image ? `<div class="${cls}" style="background-image:url('${image}')"></div>` : `<div class="${cls} none">No image</div>`);
  return `<div class="panel">
  <div class="block">
    <p class="label">Search result</p>
    <div class="serp">
      <p class="crumbs">${esc(s.og.siteName ?? host)}<br><span>${esc(cut(crumbs, 70))}</span></p>
      <p class="serp-title">${s.title ? esc(cut(s.title, 60)) : missing('No page title')}</p>
      <p class="serp-desc">${s.description ? esc(cut(s.description, 158)) : missing('No meta description: the search engine picks text from the page')}</p>
    </div>
  </div>
  <div class="row">
    <div class="block">
      <p class="label">LinkedIn, Facebook${s.twitter.card === 'summary_large_image' ? ' and X' : ''}</p>
      <div class="social">
        ${picture('social-img')}
        <div class="social-text">
          <p class="host">${esc(host.toUpperCase())}</p>
          <p class="social-title">${title ? esc(cut(title, 88)) : missing('No title')}</p>
          <p class="social-desc">${description ? esc(cut(description, 110)) : missing('No summary')}</p>
        </div>
      </div>
    </div>
    <div class="block">
      <p class="label">WhatsApp, Slack and messages</p>
      <div class="chat">
        ${picture('chat-img')}
        <div>
          <p class="social-title">${title ? esc(cut(title, 60)) : missing('No title')}</p>
          <p class="social-desc">${description ? esc(cut(description, 90)) : missing('No summary')}</p>
          <p class="host">${esc(host)}</p>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

const STYLE = `
body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #fff; color: #202124; }
.panel { width: 1000px; padding: 20px; box-sizing: border-box; display: grid; gap: 20px; }
.row { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; align-items: start; }
.label { margin: 0 0 6px; font-size: 13px; font-weight: bold; color: #5f6368; text-transform: uppercase; letter-spacing: .04em; }
.serp { border: 1px solid #dadce0; border-radius: 8px; padding: 14px 16px; }
.crumbs { margin: 0; font-size: 14px; color: #202124; } .crumbs span { color: #4d5156; font-size: 12px; }
.serp-title { margin: 6px 0 4px; font-size: 20px; color: #1a0dab; }
.serp-desc { margin: 0; font-size: 14px; color: #4d5156; line-height: 1.45; }
.social { border: 1px solid #d0d4d9; border-radius: 8px; overflow: hidden; }
.social-img { aspect-ratio: 1.91 / 1; background: #eef0f2 center / cover no-repeat; }
.social-text { padding: 10px 12px; background: #f2f3f5; }
.host { margin: 0; font-size: 12px; color: #65676b; }
.social-title { margin: 3px 0; font-size: 16px; font-weight: bold; color: #050505; }
.social-desc { margin: 0; font-size: 13px; color: #65676b; line-height: 1.4; }
.chat { display: grid; grid-template-columns: 96px 1fr; gap: 10px; background: #e7f6dd; border-radius: 8px; padding: 8px; border-left: 4px solid #25a244; }
.chat-img { width: 96px; height: 96px; border-radius: 4px; background: #d9dde1 center / cover no-repeat; }
.none { display: flex; align-items: center; justify-content: center; color: #80868b; font-size: 13px; }
.missing { color: #b3261e; font-style: italic; font-weight: normal; }
`;

/** One PNG per page showing its search result and share previews. */
export async function previewPngs(pages: PreviewPage[], runDir: string): Promise<Buffer[]> {
  if (!pages.length) return [];
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ deviceScaleFactor: 1.5, viewport: { width: 1000, height: 800 } });
    const out: Buffer[] = [];
    for (const page of pages) {
      await tab.setContent(`<!doctype html><html><head><style>${STYLE}</style></head><body>${previewHtml(page, imageUri(page.sharing, runDir))}</body></html>`);
      out.push(await tab.locator('.panel').screenshot({ type: 'png' }));
    }
    return out;
  } finally {
    await browser.close();
  }
}
