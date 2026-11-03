// T30: scheduled runs from a schedule file, and the example GitHub Actions workflow's commands.
import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), 'prego-scheduled-'));
const summaryFile = join(dataDir, 'step-summary.md');

async function prego(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--conditions=development', '--import', 'tsx', 'packages/cli/src/cli.ts', '--data-dir', dataDir, ...args], {
      timeout: 300_000,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const config = (audits: unknown[]) => {
  const path = join(dataDir, `schedule-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ audits }));
  return path;
};

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('scheduled runs', () => {
  it('runs the example schedule against the fixtures and writes the GitHub summary', async () => {
    const result = await prego(['run', 'examples/scheduled/prego.schedule.json', '--quiet'], { GITHUB_STEP_SUMMARY: summaryFile });
    expect(result.stderr).not.toMatch(/✗/);
    expect(result.code).toBe(0);
    const exports = [...result.stdout.matchAll(/Export: (.+)/g)].map((m) => m[1].trim());
    expect(exports).toHaveLength(2);
    for (const dir of exports) expect(existsSync(join(dir, 'report.docx'))).toBe(true);
    // The first audit used the Productive preset.
    expect(readFileSync(join(exports[0], 'tickets.csv'), 'utf8').split('\n')[0]).toMatch(/^"Title","Assignee","Description"/);
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toMatch(/\| Acme Widgets \(fixture\) \| fixtures\/bad-site \| Complete \| \d+ \| \d+ \| \d+ \| \d+ \| \d+ \|/);
    expect(summary).toMatch(/\| Museum of Making \(fixture\) \| fixtures\/kiosk-app \| Complete \|/);
  }, 400_000);

  it('fails only when an issue is at the chosen severity or worse', async () => {
    const path = config([{ project: 'Acme Widgets (fixture)', target: 'fixtures/bad-site', checks: ['axe'], delay: 0, export: false }]);
    const passing = await prego(['run', path, '--quiet']);
    expect(passing.code).toBe(0);
    expect(passing.stdout).toMatch(/\| Complete \| \d+ \| [1-9]\d* \|/);

    const strict = config([{ project: 'Acme Widgets (fixture)', target: 'fixtures/bad-site', checks: ['axe'], delay: 0, export: false, failOn: 'Critical' }]);
    const failing = await prego(['run', strict, '--quiet']);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toMatch(/✗ Acme Widgets \(fixture\): \d+ issues? at Critical severity or worse:/);
    expect(failing.stdout).toMatch(/✗ \d+ blocking/);
  }, 300_000);

  it('checks the file and lists every problem before starting', async () => {
    const path = config([{ target: 'fixtures/bad-site', group: 'everything', password: 'hunter2', viewports: ['watch'], failOn: 'Bad' }, { project: 'x' }]);
    const result = await prego(['run', path]);
    expect(result.code).toBe(1);
    for (const problem of ['"project" is required', 'unknown group "everything"', 'never put a password in the file', '"viewports" must list', '"failOn" must be one of', 'audits[1]: "target" is required']) {
      expect(result.stderr).toContain(problem);
    }
    const needsSecret = config([{ project: 'Staging', target: 'https://staging.example.org', user: 'staging', passwordEnv: 'PREGO_TEST_MISSING_SECRET' }]);
    expect((await prego(['run', needsSecret])).stderr).toMatch(/Set PREGO_TEST_MISSING_SECRET in the environment/);
  }, 60_000);

  it('has an example workflow that builds Prego and runs the example schedule', () => {
    const workflow = readFileSync('examples/github-actions/prego-audits.yml', 'utf8');
    for (const step of ['npm ci', 'npx playwright install-deps chromium firefox webkit', 'npm run build', 'node packages/cli/dist/cli.js --data-dir data run examples/scheduled/prego.schedule.json --quiet']) {
      expect(workflow).toContain(`run: ${step}`);
    }
    expect(workflow).toMatch(/schedule:\n\s+- cron: '0 6 \* \* 1'/);
  });
});
