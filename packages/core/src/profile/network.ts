import type { BrowserContext, Page, Request, Response } from 'playwright';

// What a page downloads while Prego looks at it: every request the browser makes on its own, how
// much each weighed, and the page's own response (its headers, server address and certificate).
// Prego adds no requests of its own here: it only listens to what the site asks the browser for.

export interface NetworkEntry {
  url: string;
  /** Playwright's resource type: document, script, stylesheet, image, font, media, xhr, fetch... */
  type: string;
  /** Bytes received (headers and encoded body), or 0 when it failed or was blocked. */
  bytes: number;
  failed: boolean;
}

export interface MainResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  ip: string | null;
  certificate: { issuer: string | null; protocol: string | null; validFrom: string | null; validTo: string | null } | null;
}

export interface NetworkLog {
  /** Every request so far, with sizes. Call while the page is still open. */
  entries(): Promise<NetworkEntry[]>;
  /** The last page load's own response. */
  main(): Promise<MainResponse | null>;
}

/** Start listening to a context's requests. Only the main frame's navigations count as the page's response. */
export function recordNetwork(context: BrowserContext, page: Page): NetworkLog {
  const finished: Request[] = [];
  const failed: Request[] = [];
  let main: Response | null = null;
  context.on('requestfinished', (r) => finished.push(r));
  context.on('requestfailed', (r) => failed.push(r));
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) main = response;
  });
  return {
    async entries() {
      const done = await Promise.all(
        finished.slice(0, 2000).map(async (r): Promise<NetworkEntry> => {
          const sizes = await r.sizes().catch(() => null);
          return { url: r.url(), type: r.resourceType(), bytes: sizes ? Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize) : 0, failed: false };
        }),
      );
      return [...done, ...failed.slice(0, 500).map((r) => ({ url: r.url(), type: r.resourceType(), bytes: 0, failed: true }))];
    },
    async main() {
      const response = main as Response | null;
      if (!response) return null;
      const [headers, address, security] = await Promise.all([
        response.allHeaders().catch(() => response.headers()),
        response.serverAddr().catch(() => null),
        response.securityDetails().catch(() => null),
      ]);
      const iso = (seconds: number | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);
      return {
        url: response.url(),
        status: response.status(),
        headers,
        ip: address?.ipAddress ?? null,
        certificate: security ? { issuer: security.issuer ?? null, protocol: security.protocol ?? null, validFrom: iso(security.validFrom), validTo: iso(security.validTo) } : null,
      };
    },
  };
}
