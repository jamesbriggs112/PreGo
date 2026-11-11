import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { vulnDbDir } from '../vulndb/store.js';

// Which country and network an IP address belongs to, from IPtoASN's public-domain table, downloaded
// with the vulnerability data and read on this computer. Audits never look an address up online.
// The country is where the network is registered: close to where the server is for most hosts, but a
// content delivery network (Cloudflare, Fastly, Akamai) answers from a server near the visitor.

export const IP_TABLE_FILE = 'ip2asn.tsv.gz';

export interface IpInfo {
  /** Two-letter country code, e.g. `GB`. */
  country: string;
  /** The country's name in English, e.g. `United Kingdom`. */
  countryName: string;
  asn: number;
  /** The network's registered name, e.g. `CLOUDFLARENET`. */
  network: string;
}

interface Table {
  v4: { start: Float64Array; end: Float64Array; row: Uint32Array };
  v6: { start: bigint[]; end: bigint[]; row: number[] };
  rows: { asn: number; country: string; network: string }[];
}

/** Check a downloaded table and save it. Returns the number of address ranges in it. */
export function saveIpTable(dataDir: string, gz: Buffer): number {
  const text = gunzipSync(gz).toString('utf8');
  const lines = text.split('\n').filter((l) => l.split('\t').length >= 5).length;
  if (lines < 1000) throw new Error('The address list looks incomplete');
  const dir = vulnDbDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, IP_TABLE_FILE);
  writeFileSync(`${path}.tmp`, gz);
  renameSync(`${path}.tmp`, path);
  return lines;
}

export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function ipv6ToBigInt(ip: string): bigint | null {
  let address = ip.replace(/^\[|\]$/g, '').split('%')[0];
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (tail) {
    const n = ipv4ToNumber(tail[1]);
    if (n === null) return null;
    address = address.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

let cached: { path: string; mtime: number; table: Table } | null = null;

function loadTable(path: string): Table {
  const mtime = statSync(path).mtimeMs;
  if (cached && cached.path === path && cached.mtime === mtime) return cached.table;
  const lines = gunzipSync(readFileSync(path)).toString('utf8').split('\n');
  const rows: Table['rows'] = [];
  const rowIndex = new Map<string, number>();
  const v4s: number[] = [];
  const v4e: number[] = [];
  const v4r: number[] = [];
  const v6 = { start: [] as bigint[], end: [] as bigint[], row: [] as number[] };
  for (const line of lines) {
    const [start, end, asn, country, network] = line.split('\t');
    if (!network || asn === '0') continue;
    const key = `${asn}\t${country}\t${network}`;
    let row = rowIndex.get(key);
    if (row === undefined) {
      row = rows.push({ asn: Number(asn), country, network: network.trim() }) - 1;
      rowIndex.set(key, row);
    }
    if (start.includes(':')) {
      const s = ipv6ToBigInt(start);
      const e = ipv6ToBigInt(end);
      if (s === null || e === null) continue;
      v6.start.push(s);
      v6.end.push(e);
      v6.row.push(row);
    } else {
      const s = ipv4ToNumber(start);
      const e = ipv4ToNumber(end);
      if (s === null || e === null) continue;
      v4s.push(s);
      v4e.push(e);
      v4r.push(row);
    }
  }
  // IPtoASN's file is sorted, but the search depends on it, so make sure.
  const order4 = v4s.map((_, i) => i).sort((a, b) => v4s[a] - v4s[b]);
  const order6 = v6.start.map((_, i) => i).sort((a, b) => (v6.start[a] < v6.start[b] ? -1 : v6.start[a] > v6.start[b] ? 1 : 0));
  const table: Table = {
    v4: { start: Float64Array.from(order4, (i) => v4s[i]), end: Float64Array.from(order4, (i) => v4e[i]), row: Uint32Array.from(order4, (i) => v4r[i]) },
    v6: { start: order6.map((i) => v6.start[i]), end: order6.map((i) => v6.end[i]), row: order6.map((i) => v6.row[i]) },
    rows,
  };
  cached = { path, mtime, table };
  return table;
}

function search<T extends number | bigint>(starts: ArrayLike<T>, ends: ArrayLike<T>, value: T): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] > value) hi = mid - 1;
    else if (ends[mid] < value) lo = mid + 1;
    else return mid;
  }
  return -1;
}

const regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' });

/** Addresses that never reach the internet: this computer, a home or office network. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToNumber(ip.replace(/^::ffff:/, ''));
  if (v4 !== null) {
    const [a, b] = [Math.floor(v4 / 2 ** 24), Math.floor(v4 / 2 ** 16) % 256];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
  }
  return /^(::1?|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip.replace(/^\[|\]$/g, ''));
}

/** Look addresses up in the local table. Null when there's no table or the address isn't in it. */
export function createIpLookup(dataDir: string): (ip: string) => IpInfo | null {
  const path = join(vulnDbDir(dataDir), IP_TABLE_FILE);
  return (ip) => {
    if (!existsSync(path) || isPrivateAddress(ip)) return null;
    try {
      const table = loadTable(path);
      const v4 = ipv4ToNumber(ip.replace(/^::ffff:/, ''));
      let row = -1;
      if (v4 !== null) {
        const i = search(table.v4.start, table.v4.end, v4);
        if (i >= 0) row = table.v4.row[i];
      } else {
        const v6 = ipv6ToBigInt(ip);
        if (v6 === null) return null;
        const i = search(table.v6.start, table.v6.end, v6);
        if (i >= 0) row = table.v6.row[i];
      }
      if (row < 0) return null;
      const { asn, country, network } = table.rows[row];
      const countryName = /^[A-Z]{2}$/.test(country) ? (regionNames.of(country) ?? country) : country;
      return { asn, country, countryName, network };
    } catch {
      return null;
    }
  };
}
