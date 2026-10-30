import { join } from 'node:path';

/** Prego's local data folder (database, runs, exports, sessions). Git-ignored. */
export function defaultDataDir(): string {
  return process.env.PREGO_DATA_DIR ?? join(process.cwd(), 'data');
}
