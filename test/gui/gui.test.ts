import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportRun } from '@prego/core';
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

describe('Results and ticket triage', () => {
  let merged: { keep: string; drop: string };
  const ticketsOf = (rule: string) => gui.db.getTickets(runId).filter((t) => t.ruleId === rule);
  const rows = () => gui.page.locator('tbody tr');

  it('shows scores and a filterable ticket table with no axe violations', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}runs/${runId}`);
    await page.getByRole('heading', { name: 'Audit of Acme Widgets' }).waitFor();
    await page.getByText('Accessibility score').waitFor();
    const total = gui.db.getTickets(runId).length;
    await expect.poll(() => rows().count()).toBe(total);

    await page.getByLabel('Severity').selectOption('Critical');
    const critical = gui.db.getTickets(runId).filter((t) => t.severity === 'Critical').length;
    await expect.poll(() => rows().count()).toBe(critical);
    await expect(page.getByText(`${critical} of ${total} tickets shown`).count()).resolves.toBe(1);
    await page.getByLabel('Severity').selectOption('');

    await page.getByLabel('Search').fill('heading');
    await expect.poll(() => rows().count()).toBe(ticketsOf('heading-order').length);
    await page.getByLabel('Search').fill('');

    expect(await axeViolations(page)).toEqual([]);
  });

  it('edits a ticket and adds notes', async () => {
    const { page } = gui;
    const lang = ticketsOf('html-has-lang')[0];
    await page.getByRole('link', { name: new RegExp(lang.ticketId) }).click();
    await page.getByRole('heading', { name: new RegExp(lang.ticketId) }).waitFor();
    // Occurrence crops load.
    const crop = page.getByRole('img', { name: /^Problem outlined on/ }).first();
    await expect.poll(() => crop.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByLabel('Severity').selectOption('Low');
    await page.getByLabel('Auditor notes').fill('Confirmed with the client’s developer');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('status').getByText('Saved.').waitFor();
    expect(gui.db.getTicket(runId, lang.ticketId)).toMatchObject({ severity: 'Low', priority: 'P4', auditorNotes: 'Confirmed with the client’s developer' });
  });

  it('dismisses a ticket as a false positive', async () => {
    const { page } = gui;
    await page.getByRole('link', { name: 'Back to tickets' }).click();
    const contrast = ticketsOf('color-contrast')[0];
    await page.getByRole('link', { name: new RegExp(contrast.ticketId) }).click();
    await page.getByRole('button', { name: 'Dismiss as false positive' }).click();
    await page.getByRole('button', { name: 'Restore ticket' }).waitFor();
    expect(gui.db.getTicket(runId, contrast.ticketId)!.status).toBe('Dismissed');

    await page.getByRole('link', { name: 'Back to tickets' }).click();
    await expect.poll(() => rows().filter({ hasText: contrast.ticketId }).count()).toBe(0);
    await page.getByLabel('Status').selectOption('Dismissed');
    await expect.poll(() => rows().count()).toBe(1);
    await page.getByLabel('Status').selectOption('open');
  });

  it('merges selected tickets', async () => {
    const { page } = gui;
    const [keep, drop] = ticketsOf('heading-order');
    await page.getByLabel(`Select ${keep.ticketId}`).check();
    await page.getByLabel(`Select ${drop.ticketId}`).check();
    await page.getByRole('button', { name: 'Merge selected (2)' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Merge 2 tickets' }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByLabel(new RegExp(keep.ticketId)).check();
    await dialog.getByRole('button', { name: `Merge into ${keep.ticketId}` }).click();
    await dialog.waitFor({ state: 'detached' });
    await expect.poll(() => rows().filter({ hasText: drop.ticketId }).count()).toBe(0);
    expect(gui.db.getTicket(runId, keep.ticketId)!.occurrences).toBe(keep.occurrences + drop.occurrences);
    merged = { keep: keep.ticketId, drop: drop.ticketId };
  });

  it('carries every change into the next export', async () => {
    const { keep, drop } = merged;
    const exported = await exportRun(gui.db, runId, { dataDir: gui.dataDir });
    const csv = readFileSync(join(exported.dir, 'tickets.csv'), 'utf8');
    expect(csv).toContain('Confirmed with the client’s developer');
    expect(csv).not.toContain(`"${ticketsOf('color-contrast').find((t) => t.status === 'Dismissed')!.ticketId}"`);
    expect(csv).not.toContain(`"${drop}"`);
    expect(csv).toContain(`"${keep}"`);
  });
});
