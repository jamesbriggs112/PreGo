import { HeadingLevel, type Paragraph, type Table } from 'docx';
import type { OutlineEntry } from './plan.js';
import { notes, type SectionContext } from './sections.js';
import { buildSiteProfile, type SiteProfile } from '../profile/profile.js';
import type { ClientInfo } from '../profile/client.js';

// Two optional report sections: About the client (written by the team, never contacts or internal
// notes) and the Site profile (weight and carbon, what the site runs on, outside services, server,
// certificate and accessibility statement).

type Block = Paragraph | Table;

const CLIENT_ROWS: [keyof ClientInfo, string][] = [
  ['about', 'About the organisation'],
  ['sector', 'Sector'],
  ['goals', 'What the site needs to achieve'],
  ['audiences', 'Who the site is for'],
  ['constraints', 'Constraints'],
];

export function clientSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, writtenText } = ctx.helpers;
  const client = ctx.plan.project.settings.client ?? {};
  const out: Block[] = [
    heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1),
    para('Background from our conversations with the client, which shaped how we read the findings.'),
  ];
  for (const [key, label] of CLIENT_ROWS) {
    const text = client[key];
    if (typeof text === 'string' && text) out.push(heading(label, HeadingLevel.HEADING_2), ...writtenText(text));
  }
  return [...out, ...notes(ctx, 'client')];
}

export const kb = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
export const grams = (g: number) => (g < 0.1 ? `${g.toFixed(3)} g` : `${g.toFixed(2)} g`);
/** IPtoASN's network name without the registry code, e.g. `Cloudflare, Inc.` */
export const networkName = (network: string) => network.split(' - ').slice(1).join(' - ') || network;

export function profileSection(ctx: SectionContext, entry: OutlineEntry): Block[] {
  const { heading, para, table, plural } = ctx.helpers;
  const profile = buildSiteProfile(ctx.plan.locations, { greenHosting: ctx.plan.project.settings.client?.greenHosting === 'yes' }) as SiteProfile;
  const out: Block[] = [
    heading(`${entry.number}. ${entry.title}`, HeadingLevel.HEADING_1),
    para(
      `What the site runs on, what its pages weigh, and the outside services they load, from what a visitor’s browser received on the ${profile.pages} ${plural(profile.pages, 'page')} Prego profiled.`,
    ),
  ];
  if (profile.carbon) {
    const c = profile.carbon;
    out.push(
      heading('Page weight and carbon', HeadingLevel.HEADING_2),
      para(
        `An average page view downloads ${kb(c.averageBytes)} and produces an estimated ${grams(c.averageGrams)} of CO2e, rated ${c.rating} on a scale from A+ (best) to F. ` +
          `${Math.round(c.thirdPartyShare * 100)}% of the data comes from other organisations’ servers. ` +
          (c.greenHosting
            ? 'The estimate assumes the host runs on renewable energy, as the client told us.'
            : 'The estimate assumes the host doesn’t run on renewable energy; it would be lower if it does.'),
      ),
      para(
        'Estimated with the Sustainable Web Design model (version 4) through the Green Web Foundation’s CO2.js. It averages data centres, networks and devices, so treat it as a guide for comparing pages and tracking progress.',
      ),
      table(
        ['Where the data goes', 'Share'],
        c.byGroup.slice(0, 6).map((g) => [
          g.group,
          `${Math.round(
            (g.bytes /
              Math.max(
                1,
                c.byGroup.reduce((s, x) => s + x.bytes, 0),
              )) *
              100,
          )}%`,
        ]),
        { fontSize: 18 },
      ),
      heading('Heaviest pages', HeadingLevel.HEADING_3),
      table(
        ['Page', 'Weight', 'CO2e per view', 'Rating'],
        c.pages.slice(0, 8).map((p) => [p.title || new URL(p.url).pathname, kb(p.bytes), grams(p.carbon.grams), p.carbon.rating]),
        { fontSize: 18 },
      ),
    );
  }
  const rows: string[][] = [];
  const s = profile.start;
  if (s?.server?.location) rows.push(['Server', `${s.server.location.countryName}, on ${networkName(s.server.location.network)}’s network`]);
  if (profile.countries.length > 1) rows.push(['Pages served from', profile.countries.join(', ')]);
  if (s?.certificate?.validTo)
    rows.push([
      'Security certificate',
      `Valid until ${s.certificate.validTo.slice(0, 10)}${s.certificate.daysLeft !== null ? ` (${s.certificate.daysLeft} days)` : ''}${s.certificate.issuer ? `, issued by ${s.certificate.issuer}` : ''}`,
    ]);
  if (profile.statement) rows.push(['Accessibility statement', statementText(profile.statement)]);
  if (rows.length) {
    out.push(heading('Hosting and housekeeping', HeadingLevel.HEADING_2), table(['', ''], rows, { headerRow: false, boldFirstColumn: true }));
    if (s?.server?.location && profile.technologies.some((t) => t.category === 'Content delivery')) {
      out.push(
        para(
          'The site is behind a content delivery network, which answers from a server near each visitor, so the country above is where the network is registered, not necessarily where the site’s own server is.',
        ),
      );
    }
  }
  const built = profile.technologies.filter((t) => t.category !== 'Analytics' && t.category !== 'Advertising');
  if (built.length) {
    out.push(
      heading('What the site is built with', HeadingLevel.HEADING_2),
      para('Found from what the browser received: headers, file addresses, cookie names and markers in the page. Confirm anything important with whoever runs the site.'),
      table(
        ['Technology', 'Type', 'How we know'],
        built.slice(0, 30).map((t) => [`${t.name}${t.version ? ` ${t.version}` : ''}`, t.category, t.evidence]),
        { fontSize: 18 },
      ),
    );
  }
  if (profile.thirdParties.length) {
    out.push(
      heading('Outside services', HeadingLevel.HEADING_2),
      para(
        `Pages load files from or send data to ${profile.thirdParties.length} other ${plural(profile.thirdParties.length, 'address')}. Each one learns the visitor’s IP address and which page they’re on, so each should be needed and covered by the privacy notice.`,
      ),
      table(
        ['Service', 'Type', 'Pages', 'Data'],
        profile.thirdParties
          .slice(0, 25)
          .map((t) => [t.service ? `${t.service} (${t.host})` : t.host, t.category ?? '–', String(t.pages), t.blocked ? 'Blocked by Prego' : kb(t.bytes)]),
        { fontSize: 18 },
      ),
    );
  }
  return [...out, ...notes(ctx, 'profile')];
}

export function statementText(s: NonNullable<SiteProfile['statement']>): string {
  if (!s.url) return 'None linked from the pages checked';
  if (!s.read) return `Linked (${s.url}), but Prego couldn’t read it`;
  const parts = [
    s.updated ? `last reviewed ${s.updated}` : 'no review date found',
    s.wcag ? `measured against WCAG ${s.wcag}` : null,
    s.compliance ? `says it is ${s.compliance === 'full' ? 'fully' : s.compliance === 'partial' ? 'partially' : 'not'} compliant` : null,
  ];
  return `${s.url}: ${parts.filter(Boolean).join(', ')}`;
}
