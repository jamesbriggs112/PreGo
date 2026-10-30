export const VERSION = '2.0.0-alpha.0';

export { serveFolder, type StaticServer, type StaticServerOptions } from './serve/static-server.js';
export * from './types.js';
export { PregoDb, slugify } from './db/database.js';
