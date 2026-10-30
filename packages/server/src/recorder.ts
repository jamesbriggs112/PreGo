import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export interface RecordRequest {
  url: string;
  /** Where the code generator writes the journey script. */
  outputFile: string;
}

/** Starts a recording; resolves when the auditor closes the recorder window. */
export type Recorder = (request: RecordRequest) => ChildProcess;

/**
 * Open Playwright's code generator: a browser window where the auditor clicks through the journey.
 * The script is written to the output file when the window closes.
 */
export const playwrightCodegen: Recorder = ({ url, outputFile }) => {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return spawn(process.execPath, [cli, 'codegen', '--target', 'javascript', '--output', outputFile, url], { stdio: 'ignore' });
};

export interface Recording {
  projectId: number;
  name: string;
  status: 'recording' | 'saved' | 'failed';
  error?: string;
}
