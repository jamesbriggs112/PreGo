import { connect, type TLSSocket } from 'node:tls';

export interface TlsReport {
  host: string;
  validTo: Date | null;
  authorized: boolean;
  /** Why the certificate isn't trusted, as Node reports it. */
  error: string | null;
  /** The protocol accepted when only TLS 1.0 and 1.1 are offered, if any. */
  legacyProtocol: string | null;
}

function handshake(host: string, port: number, options: { legacy?: boolean; ca?: string }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      ca: options.ca,
      ...(options.legacy && { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' }),
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error('timed out')));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * The certificate and protocols a site accepts: the same handshakes a browser makes, one of them
 * offering only the old protocols. No requests are sent over the connections.
 */
export async function checkTls(host: string, port = 443, options: { ca?: string } = {}): Promise<TlsReport> {
  const socket = await handshake(host, port, options);
  const certificate = socket.getPeerCertificate();
  const report: TlsReport = {
    host,
    validTo: certificate?.valid_to ? new Date(certificate.valid_to) : null,
    authorized: socket.authorized,
    error: socket.authorizationError ? String(socket.authorizationError) : null,
    legacyProtocol: null,
  };
  socket.end();
  try {
    const legacy = await handshake(host, port, { ...options, legacy: true });
    report.legacyProtocol = legacy.getProtocol();
    legacy.end();
  } catch {
    // Refused: good.
  }
  return report;
}
