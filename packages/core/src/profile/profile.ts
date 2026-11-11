import type { BrowserContext, Page } from 'playwright';
import type { Location } from '../types.js';
import { trackerName } from '../browser/trackers.js';
import type { NetworkLog } from './network.js';
import type { IpInfo } from './ip-lookup.js';
import { carbonFor, CARBON_RATINGS, type CarbonEstimate, type CarbonRating } from './carbon.js';
import { detectTechnologies, readTechMarkers, serviceFor, TECH_CATEGORIES, type DetectedTech, type TechCategory } from './technologies.js';
import { sameSite } from './site.js';

// The site profile: what each page weighs, which outside services it loads, what the site is built
// with and runs on, where its server is and when its certificate runs out. All of it comes from what
// the browser already received while Prego looked at the page.

export type WeightGroup = 'HTML' | 'Scripts' | 'Styles' | 'Images' | 'Fonts' | 'Video and audio' | 'Data' | 'Other';
export const WEIGHT_GROUPS: WeightGroup[] = ['Images', 'Scripts', 'Fonts', 'Styles', 'HTML', 'Video and audio', 'Data', 'Other'];

const GROUP_OF: Record<string, WeightGroup> = {
  document: 'HTML',
  script: 'Scripts',
  stylesheet: 'Styles',
  image: 'Images',
  font: 'Fonts',
  media: 'Video and audio',
  xhr: 'Data',
  fetch: 'Data',
  eventsource: 'Data',
  websocket: 'Data',
};

export interface ThirdParty {
  host: string;
  /** The service Prego recognises, e.g. `Google Fonts`, or null. */
  service: string | null;
  category: TechCategory | null;
  requests: number;
  bytes: number;
  /** A tracker Prego's browsers never let through (see browser/trackers.ts). */
  blocked: boolean;
}

export interface ServerInfo {
  ip: string;
  /** From Prego's local copy of IPtoASN; null when there's no copy or the address is private. */
  location: IpInfo | null;
}

export interface CertificateInfo {
  issuer: string | null;
  protocol: string | null;
  validFrom: string | null;
  validTo: string | null;
}

/** Stored on each page as `metrics.profile`. */
export interface PageProfile {
  url: string;
  /** Bytes the page downloaded (headers and compressed bodies). */
  bytes: number;
  requests: number;
  byGroup: Partial<Record<WeightGroup, number>>;
  firstPartyBytes: number;
  thirdParties: ThirdParty[];
  technologies: DetectedTech[];
  server: ServerInfo | null;
  certificate: CertificateInfo | null;
  status: number | null;
}

/** Work out a page's profile from what its browser received. Never throws: returns null instead. */
export async function capturePageProfile(page: Page, context: BrowserContext, network: NetworkLog, lookup: (ip: string) => IpInfo | null): Promise<PageProfile | null> {
  try {
    const [entries, main, markers, cookies] = await Promise.all([
      network.entries(),
      network.main(),
      readTechMarkers(page).catch(() => ({ generator: null, markers: [] })),
      context.cookies().catch(() => []),
    ]);
    const pageUrl = main?.url ?? page.url();
    if (!/^https?:/.test(pageUrl)) return null;
    const siteHost = new URL(pageUrl).hostname;
    const byGroup: PageProfile['byGroup'] = {};
    const third = new Map<string, ThirdParty>();
    let bytes = 0;
    let firstPartyBytes = 0;
    for (const entry of entries) {
      let host: string;
      try {
        host = new URL(entry.url).hostname;
      } catch {
        continue;
      }
      if (!/^https?:/.test(entry.url)) continue;
      bytes += entry.bytes;
      const group = GROUP_OF[entry.type] ?? 'Other';
      byGroup[group] = (byGroup[group] ?? 0) + entry.bytes;
      if (sameSite(host, siteHost)) {
        firstPartyBytes += entry.bytes;
        continue;
      }
      const existing = third.get(host);
      if (existing) {
        existing.requests++;
        existing.bytes += entry.bytes;
        if (!existing.service) Object.assign(existing, serviceOrTracker(entry.url, host));
      } else {
        third.set(host, { host, ...serviceOrTracker(entry.url, host), requests: 1, bytes: entry.bytes, blocked: !!trackerName(host) });
      }
    }
    const location = main?.ip ? lookup(main.ip) : null;
    const technologies = detectTechnologies({
      headers: main?.headers ?? {},
      cookies: cookies.map((c) => c.name),
      urls: entries.map((e) => e.url),
      generator: markers.generator,
      markers: markers.markers,
      network: location?.network ?? null,
    });
    return {
      url: pageUrl,
      bytes,
      requests: entries.length,
      byGroup,
      firstPartyBytes,
      thirdParties: [...third.values()].sort((a, b) => b.bytes - a.bytes || a.host.localeCompare(b.host)),
      technologies,
      server: main?.ip ? { ip: main.ip, location } : null,
      certificate: main?.certificate ?? null,
      status: main?.status ?? null,
    };
  } catch {
    return null;
  }
}

function serviceOrTracker(url: string, host: string): { service: string | null; category: TechCategory | null } {
  const known = serviceFor(url);
  if (known) return { service: known.name, category: known.category };
  const tracker = trackerName(host);
  return tracker ? { service: tracker, category: 'Advertising' } : { service: null, category: null };
}

// Across the site.

export interface SiteTech extends DetectedTech {
  /** Pages it was seen on. */
  pages: number;
}

export interface SiteThirdParty extends ThirdParty {
  pages: number;
}

export interface PageCarbon {
  locationId: number;
  url: string;
  title: string | null;
  bytes: number;
  carbon: CarbonEstimate;
}

export interface AccessibilityStatementInfo {
  /** The statement's address, or null when no page links one. */
  url: string | null;
  linkText: string | null;
  /** The page it was found on. */
  foundOn: string | null;
  /** The most recent date the statement says it was prepared, reviewed or updated (YYYY-MM-DD). */
  updated: string | null;
  /** The WCAG version it measures against, e.g. `2.2`. */
  wcag: string | null;
  /** What it says about compliance: `full`, `partial` or `none`. */
  compliance: 'full' | 'partial' | 'none' | null;
  /** Whether Prego could read the statement. */
  read: boolean;
}

export interface SiteProfile {
  pages: number;
  /** The start page's figures, or the first page with a profile. */
  start: { url: string; server: ServerInfo | null; certificate: (CertificateInfo & { daysLeft: number | null }) | null } | null;
  /** Other countries the site's pages were served from (several servers). */
  countries: string[];
  carbon: {
    greenHosting: boolean;
    /** Average grams per page view across the pages profiled. */
    averageGrams: number;
    rating: CarbonRating;
    averageBytes: number;
    /** Heaviest first. */
    pages: PageCarbon[];
    /** Where the bytes go across all the pages profiled. */
    byGroup: { group: WeightGroup; bytes: number }[];
    /** Share of all bytes from other sites, 0 to 1. */
    thirdPartyShare: number;
  } | null;
  technologies: SiteTech[];
  thirdParties: SiteThirdParty[];
  statement: AccessibilityStatementInfo | null;
  /** Days since the statement was last reviewed, when it says. */
  statementAgeDays: number | null;
}

const DAY = 86_400_000;

/** Put the pages' profiles together. `greenHosting` is what the team recorded about the host. */
export function buildSiteProfile(locations: Location[], options: { greenHosting?: boolean; now?: Date } = {}): SiteProfile | null {
  const profiled = locations
    .filter((l) => l.metrics.profile)
    .map((l) => ({ location: l, profile: l.metrics.profile as PageProfile }))
    .sort((a, b) => a.location.depth - b.location.depth || a.location.id - b.location.id);
  const statement = (locations.map((l) => l.metrics.accessibilityStatement as AccessibilityStatementInfo | undefined).find((s) => s?.url) ??
    locations.map((l) => l.metrics.accessibilityStatement as AccessibilityStatementInfo | undefined).find(Boolean) ??
    null) as AccessibilityStatementInfo | null;
  const now = options.now ?? new Date();
  const statementAgeDays = statement?.updated ? Math.floor((now.getTime() - Date.parse(statement.updated)) / DAY) : null;
  if (!profiled.length) return statement ? { pages: 0, start: null, countries: [], carbon: null, technologies: [], thirdParties: [], statement, statementAgeDays } : null;
  const green = options.greenHosting ?? false;

  const first = profiled[0].profile;
  const validTo = first.certificate?.validTo ? Date.parse(first.certificate.validTo) : NaN;
  const start = {
    url: first.url,
    server: first.server,
    certificate: first.certificate ? { ...first.certificate, daysLeft: Number.isNaN(validTo) ? null : Math.floor((validTo - now.getTime()) / DAY) } : null,
  };
  const countries = [...new Set(profiled.map((p) => p.profile.server?.location?.countryName).filter((c): c is string => !!c))];

  const pages: PageCarbon[] = profiled
    .filter((p) => p.profile.bytes > 0)
    .map((p) => ({ locationId: p.location.id, url: p.profile.url, title: p.location.title, bytes: p.profile.bytes, carbon: carbonFor(p.profile.bytes, green) }))
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = pages.reduce((s, p) => s + p.bytes, 0);
  const groups = new Map<WeightGroup, number>();
  for (const { profile } of profiled) for (const [g, b] of Object.entries(profile.byGroup)) groups.set(g as WeightGroup, (groups.get(g as WeightGroup) ?? 0) + (b ?? 0));
  const thirdBytes = profiled.reduce((s, p) => s + (p.profile.bytes - p.profile.firstPartyBytes), 0);
  const averageBytes = pages.length ? Math.round(totalBytes / pages.length) : 0;
  const average = carbonFor(averageBytes, green);
  const carbon = pages.length
    ? {
        greenHosting: green,
        averageGrams: Math.round((pages.reduce((s, p) => s + p.carbon.grams, 0) / pages.length) * 1000) / 1000,
        rating: average.rating,
        averageBytes,
        pages,
        byGroup: WEIGHT_GROUPS.map((group) => ({ group, bytes: groups.get(group) ?? 0 }))
          .filter((g) => g.bytes > 0)
          .sort((a, b) => b.bytes - a.bytes),
        thirdPartyShare: totalBytes ? Math.min(1, Math.max(0, thirdBytes / profiled.reduce((s, p) => s + p.profile.bytes, 0))) : 0,
      }
    : null;

  const tech = new Map<string, SiteTech>();
  for (const { profile } of profiled) {
    for (const t of profile.technologies) {
      const seen = tech.get(t.name);
      if (seen) {
        seen.pages++;
        seen.version ??= t.version;
      } else tech.set(t.name, { ...t, pages: 1 });
    }
  }
  const third = new Map<string, SiteThirdParty>();
  for (const { profile } of profiled) {
    for (const t of profile.thirdParties) {
      const seen = third.get(t.host);
      if (seen) {
        seen.pages++;
        seen.requests += t.requests;
        seen.bytes += t.bytes;
      } else third.set(t.host, { ...t, pages: 1 });
    }
  }
  const order = (c: TechCategory) => TECH_CATEGORIES.indexOf(c);
  return {
    pages: profiled.length,
    start,
    countries,
    carbon,
    technologies: [...tech.values()].sort((a, b) => order(a.category) - order(b.category) || b.pages - a.pages || a.name.localeCompare(b.name)),
    thirdParties: [...third.values()].sort((a, b) => b.pages - a.pages || b.bytes - a.bytes || a.host.localeCompare(b.host)),
    statement,
    statementAgeDays,
  };
}

export { CARBON_RATINGS };
