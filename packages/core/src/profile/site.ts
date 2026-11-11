// Whether two addresses belong to the same site, without a full public-suffix list: the last two
// labels, or three when the second-to-last is a common second-level suffix (example.co.uk).

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ltd', 'plc', 'sch', 'nhs', 'police', 'mod', 'me', 'nom', 'gob', 'or', 'ne', 'go']);

/** The part of a host name the site owner registered, e.g. `example.co.uk` for `www.shop.example.co.uk`. */
export function siteBase(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2 || /^[\d.]+$|:/.test(host)) return labels.join('.');
  const second = labels[labels.length - 2];
  const take = labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function sameSite(host: string, siteHost: string): boolean {
  return host.toLowerCase() === siteHost.toLowerCase() || siteBase(host) === siteBase(siteHost);
}
