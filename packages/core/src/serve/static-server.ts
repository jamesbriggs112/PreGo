import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
};

const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.svg']);

export interface StaticServerOptions {
  /** Port to listen on. 0 (the default) picks a free port. */
  port?: number;
  host?: string;
  /** Require HTTP basic auth with these credentials. */
  basicAuth?: { username: string; password: string };
  /**
   * Replace `{{ORIGIN}}` in text files with the server's origin. Sitemaps need absolute URLs,
   * so fixtures write `{{ORIGIN}}/page.html` and get the real origin at serve time.
   */
  substituteOrigin?: boolean;
  /** Extra response headers on every file (e.g. security headers, for tests). */
  headers?: Record<string, string>;
}

export interface StaticServer {
  /** Origin with a trailing slash, e.g. `http://127.0.0.1:53211/`. */
  url: string;
  origin: string;
  close(): Promise<void>;
}

/** Serve a folder over HTTP on localhost, so Prego can audit local builds and fixtures. */
export async function serveFolder(folder: string, options: StaticServerOptions = {}): Promise<StaticServer> {
  const root = resolve(folder);
  const host = options.host ?? '127.0.0.1';
  let origin = '';

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal server error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (options.basicAuth && !isAuthorised(req, options.basicAuth)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="prego"' });
      res.end('Authentication required');
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let filePath = normalize(join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');
    const ext = extname(filePath).toLowerCase();
    let body: Buffer | string;
    try {
      body = await readFile(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="en"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>');
      return;
    }
    if (options.substituteOrigin && TEXT_EXTENSIONS.has(ext)) {
      body = body.toString('utf8').replaceAll('{{ORIGIN}}', origin);
    }
    res.writeHead(200, { ...options.headers, 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(body);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://${host}:${port}`;

  return {
    url: `${origin}/`,
    origin,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

function isAuthorised(req: IncomingMessage, auth: { username: string; password: string }): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [username, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return username === auth.username && rest.join(':') === auth.password;
}
