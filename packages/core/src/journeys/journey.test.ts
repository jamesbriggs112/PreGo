import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { BrowserSession } from '../browser/session.js';
import { describeStatement, parseJourney, runStep } from './journey.js';

let site: StaticServer;
let session: BrowserSession;

beforeAll(async () => {
  site = await serveFolder('fixtures/bad-site', { substituteOrigin: true });
  session = await new BrowserSession().start();
});
afterAll(async () => {
  await session?.close();
  await site?.close();
});

const recorded = () => readFileSync('fixtures/journeys/bad-site-contact.js', 'utf8').replace('{{ORIGIN}}', site.origin);

describe('parseJourney', () => {
  it('keeps the recorded page actions and skips codegen setup and teardown', () => {
    const { steps, startUrl } = parseJourney(recorded());
    expect(steps.map((s) => s.description)).toEqual([
      `Open ${site.origin}/index.html`,
      'Click the “About” link',
      'Click the “Contact” link',
      'Type “prego.test@example.com” into “Email address”',
    ]);
    expect(startUrl).toBe(`${site.origin}/index.html`);
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
  });

  it('refuses popups and anything that reaches outside the page', () => {
    const { unsupported } = parseJourney(recorded());
    expect(unsupported).toEqual([
      { statement: "const page1Promise = page.waitForEvent('popup');", reason: 'Popups and new tabs are not replayed' },
      { statement: 'await page.goto(process.env.HOME);', reason: 'Uses something other than Playwright page actions' },
    ]);
    for (const evil of [
      "await page.goto(require('fs').readFileSync('/etc/passwd'));",
      'await page.click(`${process.exit()}`);',
      "await page.evaluate(() => fetch('https://evil.example'));",
      "await page.click('a'); process.exit();",
    ]) {
      expect(parseJourney(evil).steps).toEqual([]);
    }
  });

  it('describes statements in plain English', () => {
    expect(describeStatement("await page.getByRole('button', { name: 'Book now' }).click();")).toBe('Click the “Book now” button');
    expect(describeStatement("await page.getByLabel('Email').fill('a@b.c');")).toBe('Type “a@b.c” into “Email”');
    expect(describeStatement("await page.getByRole('checkbox', { name: 'I agree' }).check();")).toBe('Tick the “I agree” checkbox');
  });
});

describe('runStep', () => {
  it('replays steps in a page', async () => {
    const { steps } = parseJourney(recorded());
    const opened = await session.newPage('desktop');
    for (const step of steps) await runStep(opened.page, step);
    expect(new URL(opened.page.url()).pathname).toBe('/contact.html');
    await expect(opened.page.getByPlaceholder('Email address').inputValue()).resolves.toBe('prego.test@example.com');
    await opened.close();
  });

  it('will not run a statement that did not come from parsing', async () => {
    const opened = await session.newPage('desktop');
    await expect(runStep(opened.page, { index: 1, statement: 'await page.goto(process.env.HOME);', description: '' })).rejects.toThrow(/Refusing/);
    await opened.close();
  });
});
