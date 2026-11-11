import { Link } from 'react-router';
import { AlertTriangle, CircleCheck, Info, Leaf, Server, ShieldCheck } from 'lucide-react';
import type { CarbonRating, SiteProfile, TechCategory } from '@prego/core/types';
import type { RunDetail } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// The results page's Site profile tab: page weight and carbon, hosting and housekeeping, what the
// site is built with, and the outside services it loads. Everything here came from what the
// browser received while Prego looked at the pages.

const kb = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
const grams = (g: number) => (g < 0.1 ? `${g.toFixed(3)} g` : `${g.toFixed(2)} g`);
const networkName = (network: string) => network.split(' - ').slice(1).join(' - ') || network;
const path = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

const RATING_VARIANT: Record<CarbonRating, 'success' | 'medium' | 'critical'> = {
  'A+': 'success',
  A: 'success',
  B: 'success',
  C: 'medium',
  D: 'medium',
  E: 'critical',
  F: 'critical',
};

function RatingBadge({ rating }: { rating: CarbonRating }) {
  return (
    <Badge variant={RATING_VARIANT[rating]} className="shrink-0">
      <span className="sr-only">Rating </span>
      {rating}
    </Badge>
  );
}

export function SiteProfilePanel({ run }: { run: RunDetail }) {
  const profile = run.profile;
  if (!profile || (!profile.pages && !profile.statement)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No site profile for this audit</CardTitle>
          <CardDescription>
            The site profile (page weight and carbon, hosting, technologies and outside services) is collected by audits from this version of Prego. Audit the site again to see it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        From what a visitor’s browser received on {profile.pages} {profile.pages === 1 ? 'page' : 'pages'}: headers, file addresses, cookie names and sizes. Prego asked the site
        for nothing extra.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        {profile.carbon && <CarbonCard profile={profile} projectId={run.projectId} />}
        <HousekeepingCard profile={profile} />
      </div>
      {profile.carbon && <HeaviestPages profile={profile} />}
      <TechnologiesCard profile={profile} />
      <ThirdPartiesCard profile={profile} />
    </div>
  );
}

function CarbonCard({ profile, projectId }: { profile: SiteProfile; projectId: number }) {
  const c = profile.carbon!;
  const total = c.byGroup.reduce((s, g) => s + g.bytes, 0) || 1;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Leaf className="size-5" aria-hidden="true" /> Carbon and page weight
          </CardTitle>
          <RatingBadge rating={c.rating} />
        </div>
        <CardDescription>
          Estimated with the Sustainable Web Design model (v4) through CO2.js, on this computer. A guide for comparing pages and tracking progress, not a measurement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-3 gap-4">
          <div>
            <dt className="text-sm text-muted-foreground">CO2e per page view</dt>
            <dd className="text-2xl font-semibold">{grams(c.averageGrams)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Average page</dt>
            <dd className="text-2xl font-semibold">{kb(c.averageBytes)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">From other sites</dt>
            <dd className="text-2xl font-semibold">{Math.round(c.thirdPartyShare * 100)}%</dd>
          </div>
        </dl>
        <div>
          <h3 className="mb-2 text-sm font-medium">Where the data goes</h3>
          <ul className="grid gap-2 text-sm">
            {c.byGroup.map((g) => {
              const share = g.bytes / total;
              return (
                <li key={g.group} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-3">
                  <span>{g.group}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </span>
                  <span className="text-right text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {c.greenHosting ? 'Counts the host as running on renewable energy, as recorded in ' : 'Counts the host as not running on renewable energy. If it does, say so in '}
            <Link to={`/projects/${projectId}/client`} className="text-primary underline">
              Client details
            </Link>
            .
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function HousekeepingCard({ profile }: { profile: SiteProfile }) {
  const s = profile.start;
  const cdn = profile.technologies.find((t) => t.category === 'Content delivery');
  const hosts = profile.technologies.filter((t) => t.category === 'Hosting');
  const cert = s?.certificate;
  const certTone = cert?.daysLeft == null ? null : cert.daysLeft < 0 ? 'critical' : cert.daysLeft < 30 ? 'medium' : 'success';
  const st = profile.statement;
  const stale = (profile.statementAgeDays ?? 0) > 365;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-5" aria-hidden="true" /> Hosting and housekeeping
        </CardTitle>
        <CardDescription>The start page’s server and certificate, and the site’s accessibility statement.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 text-sm">
          <div className="grid gap-0.5">
            <dt className="font-medium">Server location</dt>
            <dd>
              {s?.server?.location ? (
                <>
                  {s.server.location.countryName}, on {networkName(s.server.location.network)}’s network
                  {profile.countries.length > 1 && <span className="block text-muted-foreground">Pages came from servers in {profile.countries.join(', ')}.</span>}
                  {cdn && (
                    <span className="block text-muted-foreground">
                      Behind {cdn.name}, which answers from a server near each visitor: this is where the network is registered, not necessarily where the site’s own server is.
                    </span>
                  )}
                </>
              ) : s?.server ? (
                <span className="text-muted-foreground">
                  Not known: the address list hasn’t downloaded yet (Settings, Vulnerability data), or the server is on a private network.
                </span>
              ) : (
                <span className="text-muted-foreground">Not recorded.</span>
              )}
            </dd>
          </div>
          {hosts.length > 0 && (
            <div className="grid gap-0.5">
              <dt className="font-medium">Hosting</dt>
              <dd>{hosts.map((h) => h.name).join(', ')}</dd>
            </div>
          )}
          <div className="grid gap-0.5">
            <dt className="font-medium">Security certificate</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {cert?.validTo ? (
                <>
                  <span>
                    Valid until {new Date(cert.validTo).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                    {cert.issuer && <span className="text-muted-foreground">, issued by {cert.issuer}</span>}
                  </span>
                  {certTone && cert.daysLeft !== null && (
                    <Badge variant={certTone}>{cert.daysLeft < 0 ? 'Expired' : `${cert.daysLeft} ${cert.daysLeft === 1 ? 'day' : 'days'} left`}</Badge>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">{s?.url.startsWith('https:') ? 'Not recorded.' : 'The site isn’t served over HTTPS.'}</span>
              )}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="font-medium">Accessibility statement</dt>
            <dd className="grid gap-1">
              {!st ? (
                <span className="text-muted-foreground">Not checked: tick “Accessibility statement” in the New audit form.</span>
              ) : !st.url ? (
                <span className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-[var(--badge-high-fg)]" aria-hidden="true" /> None linked from the pages checked.
                </span>
              ) : (
                <>
                  <a href={st.url} target="_blank" rel="noreferrer" className="break-all text-primary underline">
                    {st.linkText || st.url}
                  </a>
                  {st.read ? (
                    <span className="flex items-start gap-2">
                      {st.updated ? (
                        <>
                          {stale ? (
                            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--badge-high-fg)]" aria-hidden="true" />
                          ) : (
                            <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--badge-success-fg)]" aria-hidden="true" />
                          )}
                          <span>
                            Last reviewed {new Date(st.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                            {stale && ', over a year ago'}
                          </span>
                        </>
                      ) : (
                        'No review date found in it'
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Prego couldn’t read it (it may be on another site or need a login).</span>
                  )}
                  {(st.wcag || st.compliance) && (
                    <span className="text-muted-foreground">
                      {[
                        st.wcag && `Measured against WCAG ${st.wcag}`,
                        st.compliance && `says it’s ${st.compliance === 'full' ? 'fully' : st.compliance === 'partial' ? 'partially' : 'not'} compliant`,
                      ]
                        .filter(Boolean)
                        .join('; ')}
                      .
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function HeaviestPages({ profile }: { profile: SiteProfile }) {
  const pages = profile.carbon!.pages.slice(0, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Heaviest pages</CardTitle>
        <CardDescription>Including images that load as the page is scrolled.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableCaption>
            The {pages.length} heaviest of {profile.carbon!.pages.length} pages profiled
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Page</TableHead>
              <TableHead scope="col" className="text-right">
                Weight
              </TableHead>
              <TableHead scope="col" className="text-right">
                CO2e per view
              </TableHead>
              <TableHead scope="col" className="text-right">
                Rating
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((p) => (
              <TableRow key={p.locationId}>
                <TableCell className="max-w-md">
                  <span className="block truncate font-medium">{p.title || path(p.url)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{path(p.url)}</span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">{kb(p.bytes)}</TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">{grams(p.carbon.grams)}</TableCell>
                <TableCell className="text-right">
                  <RatingBadge rating={p.carbon.rating} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TechnologiesCard({ profile }: { profile: SiteProfile }) {
  const groups = new Map<TechCategory, SiteProfile['technologies']>();
  for (const t of profile.technologies) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" aria-hidden="true" /> Built with
        </CardTitle>
        <CardDescription>What Prego recognised, and how. Sites can hide or disguise these, so confirm anything important with whoever runs the site.</CardDescription>
      </CardHeader>
      <CardContent>
        {groups.size === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing Prego recognises.</p>
        ) : (
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...groups].map(([category, techs]) => (
              <div key={category} className="grid content-start gap-1">
                <dt className="text-sm text-muted-foreground">{category}</dt>
                {techs.map((t) => (
                  <dd key={t.name} className="text-sm">
                    <span className="font-medium">
                      {t.name}
                      {t.version && ` ${t.version}`}
                    </span>
                    <span className="block text-xs [overflow-wrap:anywhere] text-muted-foreground">
                      {t.evidence}
                      {profile.pages > 1 && ` · ${t.pages} of ${profile.pages} pages`}
                    </span>
                  </dd>
                ))}
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ThirdPartiesCard({ profile }: { profile: SiteProfile }) {
  const list = profile.thirdParties;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Outside services</CardTitle>
        <CardDescription>
          Other organisations’ servers the pages load files from or send data to. Each learns the visitor’s IP address and which page they’re on, so each should be needed and named
          in the privacy notice. Known trackers are blocked by Prego, so the audit sends them nothing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">None: every file came from the site itself.</p>
        ) : (
          <Table>
            <TableCaption>
              {list.length} outside {list.length === 1 ? 'address' : 'addresses'}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Service</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col" className="text-right">
                  Pages
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Data
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((t) => (
                <TableRow key={t.host}>
                  <TableCell>
                    <span className="block font-medium">{t.service ?? t.host}</span>
                    {t.service && <span className="block text-xs break-all text-muted-foreground">{t.host}</span>}
                  </TableCell>
                  <TableCell className={cn('text-sm', !t.category && 'text-muted-foreground')}>{t.category ?? 'Unknown'}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.pages}</TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap tabular-nums">{t.blocked ? <Badge variant="medium">Tracker, blocked</Badge> : kb(t.bytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
