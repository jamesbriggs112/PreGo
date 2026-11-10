import { useState } from 'react';
import { CircleAlert, CircleCheck, ImageOff } from 'lucide-react';
import type { HeadMetrics, Location } from '@prego/core/types';
import type { RunDetail } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { projectIconUrl } from '@/components/ProjectIcon';

// How each page might look in search results and when its link is shared, from the tags in its head.
// Search engines and apps shorten and sometimes rewrite these, so the previews are approximate.

/** What the sharing check recorded, on audits from before the head was captured for every page. */
interface SharingMetrics {
  title: string;
  description: string | null;
  canonical: string | null;
  og: {
    title: string | null;
    description: string | null;
    image: string | null;
    url: string | null;
    type: string | null;
    siteName: string | null;
  };
  twitter: {
    card: string | null;
    title: string | null;
    description: string | null;
    image: string | null;
  };
  image: { file: string | null } | null;
}

interface PreviewData {
  head: Pick<HeadMetrics, 'title' | 'description' | 'canonical' | 'og' | 'twitter'> & { iconCount: number | null };
  shareImage: string | null;
}

function previewFor(location: Location): PreviewData | null {
  const head = location.metrics.head as HeadMetrics | undefined;
  if (head)
    return {
      head: { ...head, iconCount: head.icons.length },
      shareImage: head.shareImage ?? null,
    };
  const sharing = location.metrics.sharing as SharingMetrics | undefined;
  if (!sharing) return null;
  return {
    head: {
      title: sharing.title,
      description: sharing.description,
      canonical: sharing.canonical,
      og: { ...sharing.og, imageAlt: null },
      twitter: sharing.twitter,
      iconCount: null,
    },
    shareImage: sharing.image?.file ?? null,
  };
}

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The Previews tab. */
export function Previews({ run }: { run: RunDetail }) {
  const pages = run.locations.filter((l) => l.audited && previewFor(l)).sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const location = pages.find((l) => l.id === selectedId) ?? pages[0];

  if (!location) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No previews for this audit</CardTitle>
          <CardDescription>Previews come from each page’s title, description and share tags. Run the audit again to collect them.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const data = previewFor(location)!;
  const label = (l: Location) => (l.kind === 'state' ? (l.title ?? l.url) : l.url);

  return (
    <div className="space-y-6">
      <div className="grid max-w-xl gap-1.5">
        <Label htmlFor="preview-page">Page</Label>
        <NativeSelect id="preview-page" value={location.id} onChange={(e) => setSelectedId(Number(e.target.value))}>
          {pages.map((l) => (
            <option key={l.id} value={l.id}>
              {label(l)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">
        These are close to what people see, not exact: search engines and apps shorten titles and descriptions, and sometimes write their own.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <SearchPreview run={run} location={location} data={data} />
        <SharePreview run={run} location={location} data={data} />
      </div>
      <TagChecklist data={data} />
    </div>
  );
}

function SearchPreview({ run, location, data }: { run: RunDetail; location: Location; data: PreviewData }) {
  const url = new URL(location.url);
  const crumbs = [url.hostname, ...url.pathname.split('/').filter(Boolean)].join(' › ');
  // Only a real icon: a logo or share image wouldn't be what Google shows.
  const icon = run.project.settings.icon?.kind === 'icon' ? projectIconUrl(run.project) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>In search results</CardTitle>
        <CardDescription>Roughly how Google lists the page.</CardDescription>
      </CardHeader>
      <CardContent>
        <figure aria-label="Search result preview" className="rounded-lg border bg-white p-4 font-[Arial,sans-serif] text-[#202124]">
          <div className="flex items-center gap-3">
            <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full border border-[#dadce0] bg-[#f1f3f4]">
              {icon ? <img src={icon} alt="" className="size-[18px] object-contain" /> : <span className="text-xs font-bold text-[#4d5156]">{url.hostname[0]?.toUpperCase()}</span>}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm">{data.head.og.siteName ?? url.hostname.replace(/^www\./, '')}</span>
              <span className="block truncate text-xs text-[#4d5156]">{crumbs}</span>
            </span>
          </div>
          <p className="mt-2 text-xl leading-snug text-[#1a0dab]">{data.head.title ? shorten(data.head.title, 60) : <em>Untitled page</em>}</p>
          <p className="mt-1 text-sm leading-normal text-[#4d5156]">
            {data.head.description ? shorten(data.head.description, 158) : <em>No description: Google would pick some text from the page.</em>}
          </p>
        </figure>
      </CardContent>
    </Card>
  );
}

function SharePreview({ run, location, data }: { run: RunDetail; location: Location; data: PreviewData }) {
  const [broken, setBroken] = useState(false);
  const host = new URL(data.head.og.url ?? location.url).hostname.replace(/^www\./, '');
  const title = data.head.og.title ?? data.head.twitter.title ?? data.head.title;
  const description = data.head.og.description ?? data.head.twitter.description ?? data.head.description;
  // The sharing check's copies are removed with the screenshots on export; Prego's own previews are kept.
  const removed = run.screenshotsDeleted && !!data.shareImage?.startsWith('sharing');
  const image = data.shareImage && !removed ? `/api/runs/${run.id}/files/${data.shareImage}` : null;
  const linked = data.head.og.image ?? data.head.twitter.image;
  return (
    <Card>
      <CardHeader>
        <CardTitle>When the link is shared</CardTitle>
        <CardDescription>Roughly how LinkedIn, Slack, WhatsApp and similar apps show it.</CardDescription>
      </CardHeader>
      <CardContent>
        <figure aria-label="Link preview" className="overflow-hidden rounded-lg border bg-card">
          {image && !broken ? (
            <img src={image} alt={data.head.og.imageAlt ?? 'The page’s share image'} className="aspect-[1.91/1] w-full bg-muted object-cover" onError={() => setBroken(true)} />
          ) : (
            <div className="grid aspect-[1.91/1] w-full place-items-center bg-muted p-4 text-center text-sm text-muted-foreground">
              <span className="grid justify-items-center gap-2">
                <ImageOff aria-hidden="true" className="size-6" />
                {linked
                  ? 'The page names a share image, but it couldn’t be loaded or was removed after export.'
                  : 'No share image: most apps show a plain text card or a small thumbnail.'}
              </span>
            </div>
          )}
          <figcaption className="space-y-1 border-t p-3">
            <span className="block text-xs tracking-wide text-muted-foreground uppercase">{host}</span>
            <span className="block font-semibold">{title ? shorten(title, 90) : <em>No title</em>}</span>
            {description && <span className="block text-sm text-muted-foreground">{shorten(description, 140)}</span>}
          </figcaption>
        </figure>
      </CardContent>
    </Card>
  );
}

function TagChecklist({ data }: { data: PreviewData }) {
  const { head } = data;
  const length = (text: string | null, min: number, max: number) =>
    !text
      ? { ok: false, found: 'Missing' }
      : {
          ok: text.length >= min && text.length <= max,
          found: `${text.length} characters (${min} to ${max} shows best)`,
        };
  const present = (value: string | null, missing = 'Missing') => (value ? { ok: true, found: shorten(value, 80) } : { ok: false, found: missing });
  const rows: { tag: string; ok: boolean; found: string }[] = [
    { tag: 'Page title', ...length(head.title || null, 10, 65) },
    { tag: 'Meta description', ...length(head.description, 50, 160) },
    { tag: 'Share title (og:title)', ...present(head.og.title) },
    {
      tag: 'Share description (og:description)',
      ...present(head.og.description),
    },
    { tag: 'Share image (og:image)', ...present(head.og.image ?? null) },
    {
      tag: 'X card (twitter:card)',
      ...present(head.twitter.card, 'Missing: X uses the share tags, with a small image'),
    },
    { tag: 'Canonical address', ...present(head.canonical) },
    ...(head.iconCount === null
      ? []
      : [
          {
            tag: 'Site icon',
            ok: head.iconCount > 0,
            found: head.iconCount > 0 ? `${head.iconCount} linked` : 'None linked from this page',
          },
        ]),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags on this page</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm">
          {rows.map((r) => (
            <li key={r.tag} className="flex items-start gap-2">
              {r.ok ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--badge-success-fg)]" />
              ) : (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--badge-high-fg)]" />
              )}
              <span>
                <span className="font-medium">{r.tag}:</span> <span className="sr-only">{r.ok ? 'fine.' : 'needs a look.'}</span>{' '}
                <span className="break-all text-muted-foreground">{r.found}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
