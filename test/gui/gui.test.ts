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
