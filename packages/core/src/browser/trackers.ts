/**
 * Advertising and analytics services that need consent under UK and EU rules. Prego's browsers
 * can't reach them, so audits never send client visitors' data to them or show up in the client's
 * analytics; the privacy check still sees every attempt.
 */
export const TRACKERS: { name: string; domains: string[] }[] = [
  { name: 'Google Analytics', domains: ['google-analytics.com', 'analytics.google.com'] },
  { name: 'Google Tag Manager', domains: ['googletagmanager.com'] },
  { name: 'Google Ads', domains: ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com'] },
  { name: 'Meta (Facebook) Pixel', domains: ['facebook.net', 'facebook.com'] },
  { name: 'Hotjar', domains: ['hotjar.com', 'hotjar.io'] },
  { name: 'Microsoft Clarity', domains: ['clarity.ms'] },
  { name: 'Microsoft Advertising', domains: ['bat.bing.com'] },
  { name: 'LinkedIn Insight', domains: ['licdn.com', 'ads.linkedin.com', 'px.ads.linkedin.com'] },
  { name: 'TikTok Pixel', domains: ['analytics.tiktok.com'] },
  { name: 'X (Twitter) Ads', domains: ['ads-twitter.com', 'analytics.twitter.com'] },
  { name: 'Pinterest Tag', domains: ['ct.pinterest.com'] },
  { name: 'Snap Pixel', domains: ['sc-static.net', 'tr.snapchat.com'] },
  { name: 'Segment', domains: ['segment.com', 'segment.io'] },
  { name: 'Mixpanel', domains: ['mixpanel.com', 'mxpnl.com'] },
  { name: 'HubSpot', domains: ['hs-analytics.net', 'hs-scripts.com', 'hs-banner.com'] },
  { name: 'Advertising network', domains: ['quantserve.com', 'scorecardresearch.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'adnxs.com'] },
];

export function trackerName(host: string): string | null {
  const h = host.toLowerCase();
  return TRACKERS.find((t) => t.domains.some((d) => h === d || h.endsWith(`.${d}`)))?.name ?? null;
}

/**
 * Wraps a request listener so it hears only requests that can leave the machine: tracker hosts
 * can't be resolved, so attempts to reach them go nowhere.
 */
export function reportUntracked(onRequest: (url: string) => void): (request: { url(): string }) => void {
  return (request) => {
    let host = '';
    try {
      host = new URL(request.url()).hostname;
    } catch {
      // Not a URL with a host (data:, blob:): report it as is.
    }
    if (!trackerName(host)) onRequest(request.url());
  };
}

/** A Chromium flag that makes tracker hosts unreachable without routing every request through Node. */
export function blockTrackersFlag(): string {
  const rules = TRACKERS.flatMap((t) => t.domains.flatMap((d) => [`MAP ${d} ~NOTFOUND`, `MAP *.${d} ~NOTFOUND`]));
  return `--host-resolver-rules=${rules.join(', ')}`;
}
