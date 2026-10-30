import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { axeViolations, startGui, type Gui } from './harness.js';

const fixture = resolve('fixtures/bad-site');
let gui: Gui;
let runId: number;

beforeAll(async () => {
  gui = await startGui();
}, 60_000);

afterAll(async () => {
  await gui?.close();
});

describe('Projects screen', () => {
  it('starts empty and lets you add a project', async () => {
    const { page } = gui;
    await page.goto(gui.url);
    await expect(page.title()).resolves.toBe('Projects · Prego');
    await page.getByText('No projects yet').waitFor();
    await page.getByLabel('Project name').fill('Acme Widgets');
    await page.getByRole('button', { name: 'Add project' }).click();
    await page.getByRole('cell', { name: 'Acme Widgets', exact: true }).waitFor();
    expect(gui.db.listProjects().map((p) => p.name)).toEqual(['Acme Widgets']);
  });

  it('has no axe violations', async () => {
    expect(await axeViolations(gui.page)).toEqual([]);
  });
});

describe('New audit screen', () => {
  it('opens prefilled from a project and has no axe violations', async () => {
    const { page } = gui;
    await page.getByRole('link', { name: 'New audit of Acme Widgets' }).click();
    await page.waitForURL(/\/audits\/new/);
    await page.getByRole('heading', { name: 'New audit' }).waitFor();
    await expect(page.getByLabel('Project', { exact: true }).inputValue()).resolves.toBe('Acme Widgets');
    expect(await axeViolations(page)).toEqual([]);
  });

  it('shows the server’s message for a target it can’t audit', async () => {
    const { page } = gui;
    await page.getByLabel('Web address or folder').fill('not a site');
    await page.getByRole('button', { name: 'Start audit' }).click();
    await expect(page.getByRole('alert').textContent()).resolves.toMatch(/web address starting with http/);
  });

  it('starts a crawl and moves to the run', async () => {
    const { page } = gui;
    await page.getByLabel('Web address or folder').fill(fixture);
    await page.getByLabel('Delay between pages (milliseconds)').fill('0');
    await page.getByLabel(/Mobile/).check();
    await page.getByRole('button', { name: 'Start audit' }).click();
    await page.waitForURL(/\/runs\/\d+$/);
    runId = Number(page.url().split('/').pop());
    const run = gui.db.getRun(runId)!;
    expect(run.target).toBe(fixture);
    expect(run.settings.viewports).toEqual(['mobile', 'desktop']);
    await gui.prego.jobs.get(runId)!.done;
  }, 120_000);
});

describe('Live run screen', () => {
  it('shows progress and the current screenshot, and Stop works', async () => {
    const { page } = gui;
    const response = await page.request.post(`${gui.url}api/runs`, {
      data: { project: 'Acme Widgets', target: fixture, delayMs: 1500, viewports: ['desktop', 'mobile'] },
    });
    const { runId: slowRun } = await response.json();
    await page.goto(`${gui.url}runs/${slowRun}`);
    await page.getByRole('heading', { name: 'Auditing Acme Widgets' }).waitFor();

    // A screenshot of a checked page appears and actually loads.
    const shot = page.getByRole('img', { name: /^Screenshot of http/ });
    await shot.waitFor({ timeout: 30_000 });
    await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.getByText(/\d+ of 10 page checks done/).count()).resolves.toBe(1);
    expect(await page.getByRole('listitem').filter({ hasText: 'Checked' }).count()).toBeGreaterThan(0);

    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Stop audit' }).click();
    await page.getByText('This audit was stopped before it finished.').waitFor({ timeout: 30_000 });
    expect(gui.db.getRun(slowRun)!.status).toBe('stopped');
  }, 120_000);
});
