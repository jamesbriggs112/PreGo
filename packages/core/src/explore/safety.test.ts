import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { BrowserSession } from '../browser/session.js';
import { exploreApp, openScreen, type ExploreResult } from './explorer.js';
import { createSafety, DEFAULT_DUMMY_DATA, loadDummyData, valueFor } from './safety.js';

let kiosk: StaticServer;
let cases: StaticServer;
let session: BrowserSession;

beforeAll(async () => {
  kiosk = await serveFolder('fixtures/kiosk-app');
  cases = await serveFolder('fixtures/explore-cases');
  session = await new BrowserSession().start();
});

afterAll(async () => {
  await session?.close();
  await kiosk?.close();
  await cases?.close();
});

const edgeFor = (result: ExploreResult, label: string) => result.edges.find((e) => e.action.label === label);

describe('explorer safety on kiosk-app', () => {
  let result: ExploreResult;

  beforeAll(async () => {
    const safety = createSafety(kiosk.url);
    result = await exploreApp({ startUrl: kiosk.url, profile: 'kiosk-landscape', session, canPerform: safety.canPerform, prepareScreen: safety.prepareScreen });
  }, 120_000);

  it('never presses the denylisted "Send to my email" button', () => {
    expect(edgeFor(result, 'Send to my email')).toMatchObject({ outcome: 'skipped', to: null, reason: 'Matches denylisted label "send"' });
    expect(result.states.map((s) => s.title)).not.toContain('Postcard Sent');
    expect(result.states).toHaveLength(16);
  });

  it('never lets the idle timer reset the kiosk to its attract screen', async () => {
    const attract = result.states.find((s) => s.depth === 0)!;
    expect(result.edges.filter((e) => e.to === attract.id && e.from !== attract.id)).toEqual([]);
    // Even well past the 60-second idle timeout in real time, the frozen clock keeps the screen.
    const visit = result.states.find((s) => s.title === 'Plan Your Visit')!;
    const { opened } = await openScreen({ startUrl: kiosk.url, session }, visit.steps, 'kiosk-landscape');
    await new Promise((r) => setTimeout(r, 1500));
    await expect(opened.page.locator('h1').textContent()).resolves.toBe('Plan Your Visit');
    // Advancing the fake clock by hand proves the timer is there and only Prego decides when it runs.
    await opened.page.clock.runFor(61_000);
    await expect(opened.page.locator('h1').textContent()).resolves.toBe('Museum of Making');
    await opened.close();
  });
});

describe('explorer safety on a form screen', () => {
  let result: ExploreResult;
  const safety = () => createSafety(cases.url + 'form.html', { denySelectors: ['.danger'] });

  beforeAll(async () => {
    const s = safety();
    result = await exploreApp({ startUrl: cases.url + 'form.html', session, canPerform: s.canPerform, prepareScreen: s.prepareScreen });
  }, 60_000);

  it('skips denylisted labels, denylisted selectors, log-out links and other sites', () => {
    expect(edgeFor(result, 'Delete account')).toMatchObject({ outcome: 'skipped', reason: 'Matches denylisted label "delete"' });
    expect(edgeFor(result, 'Reset everything')).toMatchObject({ outcome: 'skipped', reason: 'Matches denylisted selector .danger' });
    expect(edgeFor(result, 'Log out')).toMatchObject({ outcome: 'skipped' });
    expect(edgeFor(result, 'Help (another site)')).toMatchObject({ outcome: 'external', reason: 'Link to another site' });
    expect(result.states.map((s) => s.title).sort()).toEqual(['Saved', 'Your account']);
  });

  it('fills forms with dummy data only, and never types a password', async () => {
    const saved = result.states.find((s) => s.title === 'Saved')!;
    const s = safety();
    const { opened } = await openScreen({ startUrl: cases.url + 'form.html', session, prepareScreen: s.prepareScreen }, saved.steps);
    await expect(opened.page.locator('#saved').textContent()).resolves.toBe('Prego Test / prego.test@example.com / no password');
    await expect(opened.page.evaluate(() => (window as unknown as { dangerousPresses: string[] }).dangerousPresses)).resolves.toEqual([]);
    await opened.close();
  });
});

describe('mask selectors', () => {
  it('stop a live clock making every visit look like a new screen', async () => {
    const startUrl = cases.url + 'clock.html';
    const unmasked = await exploreApp({ startUrl, session, maxStates: 6 });
    expect(unmasked.stoppedEarly).toBe(true);
    expect(unmasked.states.filter((s) => s.title === 'Screen one').length).toBeGreaterThan(1);

    const masked = await exploreApp({ startUrl, session, maskSelectors: ['#clock'] });
    expect(masked.states.map((s) => s.title)).toEqual(['Screen one', 'Screen two']);
    expect(masked.stoppedEarly).toBe(false);
  }, 60_000);
});

describe('dummy data', () => {
  it('chooses a value by field type and name', () => {
    const d = DEFAULT_DUMMY_DATA;
    expect(valueFor({ inputType: 'email', tag: 'input' }, '', d)).toBe(d.email);
    expect(valueFor({ inputType: 'text', tag: 'input' }, 'postcode', d)).toBe(d.postcode);
    expect(valueFor({ inputType: 'text', tag: 'input' }, 'given-name first name', d)).toBe(d.firstName);
    expect(valueFor({ inputType: 'text', tag: 'input' }, 'full name', d)).toBe(d.name);
    expect(valueFor({ inputType: undefined, tag: 'textarea' }, '', d)).toBe(d.message);
    expect(valueFor({ inputType: 'tel', tag: 'input' }, '', d)).toBe(d.tel);
  });

  it('loads values from config/dummy-data.json', () => {
    expect(loadDummyData('config/dummy-data.json')).toMatchObject({ email: 'prego.test@example.com', tel: '01632 960000' });
    expect(loadDummyData('config/missing.json')).toBe(DEFAULT_DUMMY_DATA);
  });
});
