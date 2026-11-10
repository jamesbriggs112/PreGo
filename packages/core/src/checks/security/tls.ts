import { connect, type TLSSocket } from 'node:tls';

export interface TlsReport {
  host: string;
  validTo: Date | null;
  authorized: boolean;
  /** Why the certificate isn't trusted, as Node reports it. */
  error: string | null;
}

function handshake(host: string, port: number, options: { ca?: string }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      ca: options.ca,
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timed out')));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * The site's certificate, from the same handshake a browser makes. No requests are sent over the
 * connection, and old protocols aren't tried: that would be testing the server rather than visiting it.
 */
export async function checkTls(host: string, port = 443, options: { ca?: string } = {}): Promise<TlsReport> {
  const socket = await handshake(host, port, options);
  const certificate = socket.getPeerCertificate();
  const report: TlsReport = {
    host,
    validTo: certificate?.valid_to ? new Date(certificate.valid_to) : null,
    authorized: socket.authorized,
    error: socket.authorizationError ? String(socket.authorizationError) : null,
  };
  socket.end();
  return report;
}
