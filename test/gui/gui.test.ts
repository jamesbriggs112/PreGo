import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { exportRun, serveFolder, type StaticServer } from '@prego/core';
import { axeViolations, startGui, type Gui } from './harness.js';

const fixture = resolve('fixtures/bad-site');
let gui: Gui;
let runId: number;
let journeySite: StaticServer;

/** Stands in for Playwright's code generator, which opens a real browser window for the auditor. */
function fakeRecorder({ outputFile }: { url: string; outputFile: string }): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  setTimeout(() => {
    writeFileSync(outputFile, readFileSync('fixtures/journeys/bad-site-contact.js', 'utf8').replace('{{ORIGIN}}', journeySite.origin));
    child.emit('exit', 0);
  }, 500);
  return child;
}

/** Jump to a step of the New audit form. */
const goToStep = (name: string) => gui.page.getByRole('navigation', { name: 'Audit set-up steps' }).getByRole('button', { name: new RegExp(name) }).click();

beforeAll(async () => {
  journeySite = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  gui = await startGui({ recorder: fakeRecorder });
}, 60_000);

afterAll(async () => {
  await gui?.close();
  await journeySite?.close();
});

describe('Projects screen', () => {
  it('starts empty and lets you add a project', async () => {
    const { page } = gui;
    await page.goto(gui.url);
    await page.getByRole('heading', { name: 'What would you like to test?', level: 1 }).waitFor();
    await page.getByRole('navigation', { name: 'Projects' }).getByText('No projects yet').waitFor();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
    await expect(page.title()).resolves.toBe('Projects · Prego');
    await page.getByRole('main').getByText('No projects yet').waitFor();
    await page.getByLabel('Project name').fill('Acme Widgets');
    await page.getByRole('button', { name: 'Add project' }).click();
    await page.getByRole('cell', { name: 'Acme Widgets', exact: true }).waitFor();
    expect(gui.db.listProjects().map((p) => p.name)).toEqual(['Acme Widgets']);
    // The sidebar lists it, linking to a new audit until it has one.
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('link', { name: /Acme Widgets\s*No audits yet/ }).waitFor();
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
    await goToStep('Review and start');
    await page.getByRole('button', { name: 'Start audit' }).click();
    await expect(page.getByRole('alert').textContent()).resolves.toMatch(/web address starting with http/);
  });

  it('starts a crawl and moves to the run', async () => {
    const { page } = gui;
    await goToStep('Site');
    await page.getByLabel('Web address or folder').fill(fixture);
    await page.getByRole('button', { name: 'Next: Screen sizes' }).click();
    await page.getByRole('heading', { name: 'Step 2 of 5: Screen sizes' }).waitFor();
    await page.getByLabel(/Mobile/).check();
    expect(await axeViolations(page)).toEqual([]);
    await goToStep('Scope and login');
    await page.getByLabel('Delay between pages (milliseconds)').fill('0');
    await goToStep('Review and start');
    await page.getByText(fixture, { exact: true }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
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
    await page.getByLabel('Show').selectOption('Dismissed');
    await expect.poll(() => rows().count()).toBe(1);
    await page.getByLabel('Show').selectOption('open');
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

describe('Settings and Export screens', () => {
  it('saves branding and new-audit defaults', async () => {
    const { page } = gui;
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByLabel('Company name').fill('Four Agency');
    // Each section shows on its own; changes in all of them are kept until Save.
    const sections = page.getByRole('navigation', { name: 'Settings sections' });
    await sections.getByRole('link', { name: /^Exports/ }).click();
    await page.getByLabel('tickets.csv columns').selectOption('jira');
    await expect(page.getByLabel('Company name').count()).resolves.toBe(0);
    await sections.getByRole('link', { name: /^New audit defaults/ }).click();
    await page.getByLabel('Pages audited per template').fill('2');
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByRole('status').getByText('Settings saved.').waitFor();

    // The New audit form starts from the saved defaults.
    await page.getByRole('link', { name: 'New audit', exact: true }).click();
    await goToStep('Scope and login');
    await expect(page.getByLabel('Pages audited per template').inputValue()).resolves.toBe('2');
  }, 60_000);

  it('creates an export, downloads each file and the zip, with branding in the report', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}runs/${runId}`);
    await page.getByRole('link', { name: 'Export report and tickets' }).click();
    await page.getByRole('heading', { name: /^Export/, level: 1 }).waitFor();
    // This audit was exported in an earlier test, which deleted its screenshots.
    await page.getByRole('note').getByText(/screenshots were deleted when it was first exported/).waitFor();
    // The saved preset is preselected.
    await expect(page.getByLabel('Jira').isChecked()).resolves.toBe(true);
    await page.getByLabel('Prego standard columns').check();
    await page.getByRole('button', { name: 'Create export' }).click();
    await page.getByRole('status').getByText(/Export ready/).waitFor({ timeout: 60_000 });
    expect(await axeViolations(page)).toEqual([]);

    const [report] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Full findings report (Word)' }).click()]);
    const docx = await JSZip.loadAsync(readFileSync((await report.path())!));
    expect(await docx.file('word/document.xml')!.async('string')).toContain('Four Agency');

    const [tickets] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Tickets (CSV)' }).click()]);
    expect(tickets.suggestedFilename()).toMatch(/tickets\.csv$/);
    expect(readFileSync((await tickets.path())!, 'utf8')).toMatch(/^\uFEFF"Ticket ID","Title"/);

    const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download everything (.zip)' }).click()]);
    expect(zip.suggestedFilename()).toMatch(/^acme-widgets-.+\.zip$/);
    const bundle = await JSZip.loadAsync(readFileSync((await zip.path())!));
    const names = Object.keys(bundle.files);
    for (const file of ['report.docx', 'tickets.csv', 'occurrences.csv', 'run.json']) expect(names).toContainEqual(expect.stringMatching(new RegExp(`/${file.replace('.', '\\.')}$`)));
    // Screenshots are only in the report, never loose files.
    expect(names.some((n) => n.includes('/screenshots/'))).toBe(false);
  }, 120_000);

  it('previews the report', async () => {
    const { page } = gui;
    await page.getByRole('button', { name: 'Preview the report' }).click();
    const frame = page.frameLocator('iframe[title="Report preview"]');
    await frame.getByText('Executive summary').first().waitFor({ timeout: 30_000 });
    await expect(frame.getByText('Four Agency').count()).resolves.toBeGreaterThan(0);
  });

  it('switches to a client-facing report with written sections and optional sections', async () => {
    const { page } = gui;
    await page.getByLabel('Client-facing report').check();
    await page.getByRole('group', { name: 'Written sections' }).waitFor();
    await page.getByLabel('Executive summary').fill('Acme is launching a new widget shop.');
    await page.getByRole('button', { name: 'Fill in the suggestion for key findings' }).click();
    await expect(page.getByLabel('Key findings').inputValue()).resolves.toMatch(/^- Accessibility: \d+ issues/);
    await page.getByLabel('Information architecture').check();
    await page.getByLabel('Your observations').fill('The structure is flat.');
    await page.getByRole('status').getByText('Saved.').waitFor();
    await page.getByText(/Sections in the report.*Information architecture/s).waitFor();
    expect(gui.db.getReportOptions(runId)).toMatchObject({ clientFacing: true, include: { ia: true }, text: { summary: 'Acme is launching a new widget shop.', ia: 'The structure is flat.' } });
    // axe can't look inside the sandboxed preview, so check the page with it closed.
    await page.getByRole('button', { name: 'Hide report preview' }).click();
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Preview the report' }).click();
    const frame = page.frameLocator('iframe[title="Report preview"]');
    await frame.getByText('Acme is launching a new widget shop.').waitFor({ timeout: 30_000 });
    await frame.getByRole('heading', { name: /^\d+\. Information architecture$/ }).waitFor();
  }, 60_000);

  it('adds the Overview to the pack, with its own wording and preview', async () => {
    const { page } = gui;
    await page.getByLabel('Client-facing report').uncheck();
    await page.getByLabel('Overview (overview.docx)').check();
    // The Overview uses key findings and recommendations, so they stay without the client-facing layout.
    await page.getByLabel('Key findings').waitFor();
    await expect(page.getByLabel('Executive summary').count()).resolves.toBe(0);
    await expect(page.getByLabel('Why a healthy website matters').getAttribute('placeholder')).resolves.toMatch(/^A website is often the first place/);
    await page.getByLabel('Why a healthy website matters').fill('Acme’s shop is how most members renew.');
    // "Saved." is already showing from earlier changes, so wait for the save itself.
    await expect
      .poll(() => gui.db.getReportOptions(runId), { timeout: 10_000 })
      .toMatchObject({ clientFacing: false, reports: { overview: true }, text: { whyItMatters: 'Acme’s shop is how most members renew.' } });

    await page.getByLabel('Report to preview').selectOption('overview');
    const frame = page.frameLocator('iframe[title="Report preview"]');
    await frame.getByText('Acme’s shop is how most members renew.').waitFor({ timeout: 30_000 });
    await frame.getByRole('heading', { name: '1. At a glance' }).waitFor();
    await page.getByRole('button', { name: 'Hide report preview' }).click();
    expect(await axeViolations(page)).toEqual([]);
  }, 60_000);

  it('suggests purposes and personas from the audit, and saves the auditor’s changes', async () => {
    const { page } = gui;
    const projectId = gui.db.getRun(runId)!.projectId;
    await page.goto(`${gui.url}runs/${runId}`);
    await page.getByRole('link', { name: 'Purposes and audience' }).click();
    await page.getByRole('heading', { name: /^Purposes and audience: / }).waitFor();
    await page.getByRole('button', { name: 'Suggest from the latest audit' }).click();
    await page.getByRole('status').getByText(/Added Prego’s suggestions/).waitFor();
    await expect(page.getByRole('textbox', { name: 'Purpose' }).first().inputValue()).resolves.toBe('Help people get in touch');
    await expect(page.locator('input[value="On their phone, in a hurry"]').count()).resolves.toBe(1);

    // A purpose from the brief that the site doesn't serve yet shows as a gap.
    await page.getByRole('button', { name: 'Add a purpose' }).click();
    await page.getByRole('textbox', { name: 'Purpose' }).last().fill('Help people book a demo');
    await page.getByText(/^Gaps: the client wants the site to help people book a demo/).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('status').getByText('Saved.').waitFor();
    const audience = gui.db.getProject(projectId)!.settings.audience!;
    expect(audience.purposes.at(-1)).toMatchObject({ title: 'Help people book a demo', intended: true, current: false });
    expect(audience.personas.some((p) => p.internal)).toBe(true);
    expect(audience.tasks.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('Interactive exploration', () => {
  let exploreRun: number;

  it('starts an exploration from the form, with the default denylist offered', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}audits/new`);
    await page.getByLabel('Project', { exact: true }).fill('Museum of Making');
    await page.getByLabel('Web address or folder').fill(resolve('fixtures/kiosk-app'));
    await page.getByLabel('Interactive exploration').check();
    await goToStep('Scope and login');
    await expect(page.getByLabel('Never press controls labelled').inputValue()).resolves.toMatch(/^delete\nremove\n.*send/s);
    await page.getByLabel('Ignore when telling screens apart').fill('.attract-hint');
    expect(await axeViolations(page)).toEqual([]);
    await goToStep('Review and start');
    await page.getByRole('button', { name: 'Start audit' }).click();
    await page.waitForURL(/\/runs\/\d+$/);
    exploreRun = Number(page.url().split('/').pop());
    expect(gui.db.getRun(exploreRun)).toMatchObject({ mode: 'explore', settings: expect.objectContaining({ maskSelectors: ['.attract-hint'] }) });
  });

  it('shows the state map growing while it explores', async () => {
    const { page } = gui;
    await page.getByRole('heading', { name: 'Auditing Museum of Making' }).waitFor();
    await page.getByRole('group', { name: /^State map so far: \d+ screens$/ }).waitFor({ timeout: 30_000 });
    expect(await axeViolations(page)).toEqual([]);
    await gui.prego.jobs.get(exploreRun)!.done;
  }, 180_000);

  it('opens the state map, lists every screen and shows each screen’s issues', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}runs/${exploreRun}`);
    await page.getByRole('link', { name: 'State map' }).click();
    await page.getByRole('heading', { name: 'State map: Museum of Making' }).waitFor();
    await page.getByRole('group', { name: 'State map of 16 screens' }).waitFor();
    await expect(page.locator('tbody tr').count()).resolves.toBe(16);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Opening Times' }).click();
    await page.getByRole('heading', { name: 'Opening Times', level: 2 }).waitFor();
    await page.getByRole('link', { name: /Screen has no way back or home/ }).waitFor();
    await expect(page.getByText('Nothing on this screen can be pressed.').count()).resolves.toBe(1);

    await page.getByRole('button', { name: 'Paintings' }).click();
    await page.getByText(/“Zoom in”: Does nothing/).waitFor();
    await page.getByText(/“Back”: Goes to “Our Collection”/).waitFor();
  });

  it('remembers the denylist and masks for the project next time', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}audits/new?project=${encodeURIComponent('Museum of Making')}`);
    await page.getByLabel('Interactive exploration').check();
    await goToStep('Scope and login');
    await expect(page.getByLabel('Ignore when telling screens apart').inputValue()).resolves.toBe('.attract-hint');
  });
});

describe('Scripted journeys (criterion 4)', () => {
  let journeyRun: number;

  it('records a journey from the New audit form', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}audits/new?project=${encodeURIComponent('Acme Widgets')}`);
    await page.getByLabel('Scripted journey').check();
    const journeyCard = page.locator('fieldset', { hasText: 'Journey to replay' }).locator('..');
    await journeyCard.getByLabel('Journey name').fill('Contact form');
    await journeyCard.getByLabel('Start address').fill(journeySite.url);
    await journeyCard.getByRole('button', { name: 'Record journey' }).click();
    await page.getByText(/Recording “contact-form”: a browser window has opened/).waitFor();
    // The journey appears once the recorder window "closes".
    await page.getByRole('radio', { name: 'contact-form' }).waitFor({ timeout: 15_000 });
    await expect(page.getByText(/4 steps from .*index\.html/).count()).resolves.toBe(1);
    expect(await axeViolations(page)).toEqual([]);
  });

  it('replays it with checks at every step', async () => {
    const { page } = gui;
    await page.getByRole('radio', { name: 'contact-form' }).check();
    await goToStep('Scope and login');
    await page.getByText('A journey follows its recorded steps').waitFor();
    await expect(page.getByLabel('Delay between pages (milliseconds)').count()).resolves.toBe(0);
    await goToStep('Review and start');
    await page.getByRole('button', { name: 'Start audit' }).click();
    await page.waitForURL(/\/runs\/\d+$/);
    journeyRun = Number(page.url().split('/').pop());
    await gui.prego.jobs.get(journeyRun)!.done;
    expect(gui.db.getRun(journeyRun)).toMatchObject({ status: 'complete', mode: 'journey', summary: expect.objectContaining({ stepsReplayed: 4, completed: true }) });
    const locations = gui.db.getLocations(journeyRun);
    expect(locations).toHaveLength(4);
    for (const location of locations) expect(gui.db.getRawFindings(journeyRun).some((f) => f.locationId === location.id)).toBe(true);
  }, 180_000);

  it('shows the journey results, filterable by step', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}runs/${journeyRun}`);
    await page.getByText('Journey steps audited').waitFor();
    await expect(page.getByText('4 of 4').count()).resolves.toBe(1);
    await page.getByLabel('Step', { exact: true }).selectOption({ label: 'Step 3: Click the “Contact” link' });
    await expect.poll(() => page.locator('tbody tr').filter({ hasText: 'Form fields have no label' }).count()).toBe(1);
    expect(await axeViolations(page)).toEqual([]);
  }, 120_000);
});

describe('Deleting a project', () => {
  it('asks first, and Cancel keeps the project', async () => {
    const { page } = gui;
    gui.db.createProject('Throwaway');
    await page.goto(`${gui.url}projects`);
    await page.getByRole('button', { name: 'Delete Throwaway' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Throwaway?' });
    await dialog.getByText('its 0 audits').waitFor();
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(gui.db.listProjects().some((p) => p.name === 'Throwaway')).toBe(true);
  });

  it('deletes the project once confirmed', async () => {
    const { page } = gui;
    await page.getByRole('button', { name: 'Delete Throwaway' }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('cell', { name: 'Throwaway', exact: true }).waitFor({ state: 'detached' });
    expect(gui.db.listProjects().some((p) => p.name === 'Throwaway')).toBe(false);
    await page.getByRole('cell', { name: 'Acme Widgets', exact: true }).waitFor();
  });
});

describe('Dark mode', () => {
  it('switches from the header, is remembered, and every main screen passes axe in it', async () => {
    const { page } = gui;
    await page.goto(gui.url);
    const toggle = page.getByRole('button', { name: 'Dark mode' });
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await toggle.click();
    await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('true');
    await page.reload();
    await expect(page.locator('html').getAttribute('data-theme')).resolves.toBe('dark');
    // The sidebar links each project to its latest audit.
    const acme = page.getByRole('navigation', { name: 'Projects' }).getByRole('link', { name: /^Acme Widgets/ });
    await expect(acme.getAttribute('href')).resolves.toMatch(/^\/runs\/\d+$/);
    expect(await axeViolations(page)).toEqual([]);

    for (const path of ['projects', `runs/${runId}`, 'audits/new', 'settings', 'about']) {
      await page.goto(gui.url + path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page), path).toEqual([]);
    }

    await page.getByRole('button', { name: 'Dark mode' }).click();
    await expect(page.locator('html').getAttribute('data-theme')).resolves.toBe('light');
  }, 60_000);
});

describe('Test groups', () => {
  it('picks a group’s checks and estimates how long the audit takes', async () => {
    const { page } = gui;
    await page.goto(`${gui.url}audits/new`);
    await goToStep('Tests');
    await page.getByRole('radio', { name: 'Performance' }).check({ force: true });
    await expect(page.getByLabel('Performance and best practice (Lighthouse)').isChecked()).resolves.toBe(true);
    await expect(page.getByLabel('Accessibility (axe-core)').isChecked()).resolves.toBe(false);
    const estimate = page.getByText(/^Estimated time: /);
    const performance = await estimate.textContent();

    await page.getByRole('radio', { name: 'Quick check' }).check({ force: true });
    await expect(page.getByLabel('Accessibility (axe-core)').isChecked()).resolves.toBe(true);
    await expect.poll(() => estimate.textContent()).not.toBe(performance);
    await page.getByText(/earlier audits? on this computer|rough guide/).waitFor();

    // Changing a single check leaves no group selected.
    await page.getByLabel('HTML validity', { exact: true }).check();
    await expect(page.getByRole('group', { name: 'Test group' }).getByRole('radio', { checked: true }).count()).resolves.toBe(0);
    expect(await axeViolations(page)).toEqual([]);
  }, 120_000);
});


describe('Setting up an audit by typing', () => {
  it('reads the request, shows the settings to confirm, and starts only when confirmed', async () => {
    const { page } = gui;
    await page.goto(gui.url);
    const runsBefore = gui.db.listProjects().flatMap((p) => gui.db.listRuns(p.id)).length;
    await page.getByLabel('Describe the audit').fill(`quick check of ${journeySite.origin}/ on mobile`);
    await page.getByRole('button', { name: 'Set up audit' }).click();
    await page.getByRole('heading', { name: 'Check these settings' }).waitFor();
    const settings = page.getByRole('region', { name: 'Check these settings' });
    await expect(settings.getByText('Quick check').count()).resolves.toBe(1);
    await expect(settings.getByText('Mobile', { exact: true }).count()).resolves.toBe(1);
    expect(await axeViolations(page)).toEqual([]);
    expect(gui.db.listProjects().flatMap((p) => gui.db.listRuns(p.id))).toHaveLength(runsBefore);

    // Change settings opens the full form with everything filled in.
    await page.getByRole('button', { name: 'Change settings' }).click();
    await page.waitForURL(/\/audits\/new\?/);
    await page.getByRole('heading', { name: 'Step 5 of 5: Review and start' }).waitFor();
    await page.getByText('Quick check (4 checks)').waitFor();
    await goToStep('Site');
    await expect(page.getByLabel('Web address or folder').inputValue()).resolves.toBe(`${journeySite.origin}/`);
    await goToStep('Screen sizes');
    await expect(page.getByLabel(/^Mobile/).isChecked()).resolves.toBe(true);
    await expect(page.getByLabel(/^Desktop/).isChecked()).resolves.toBe(false);
    await goToStep('Tests');
    await expect(page.getByRole('radio', { name: /Quick check/ }).isChecked()).resolves.toBe(true);

    await page.goBack();
    await page.getByLabel('Describe the audit').fill(`quick check of ${journeySite.origin}/ on mobile`);
    await page.getByRole('button', { name: 'Set up audit' }).click();
    await page.getByRole('button', { name: 'Start audit' }).click();
    await page.waitForURL(/\/runs\/\d+$/);
    const started = gui.db.getRun(Number(page.url().split('/').pop()))!;
    expect(started).toMatchObject({ target: `${journeySite.origin}/` });
    expect(started.settings).toMatchObject({ viewports: ['mobile'] });
    expect((started.settings.modules as { id: string }[]).map((m) => m.id).sort()).toEqual(['axe', 'golive', 'links', 'security']);
    await gui.prego.jobs.get(started.id)!.done;
  }, 120_000);

  it('asks for the site when the request doesn’t name one', async () => {
    const { page } = gui;
    await page.goto(gui.url);
    await page.getByLabel('Describe the audit').fill('run an accessibility audit');
    await page.getByRole('button', { name: 'Set up audit' }).click();
    await page.getByText(/^Say which site to audit/).waitFor();
    await expect(page.getByRole('button', { name: 'Start audit' }).count()).resolves.toBe(0);
  });
});
