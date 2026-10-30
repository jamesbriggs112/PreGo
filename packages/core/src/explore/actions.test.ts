import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveFolder, type StaticServer } from '../serve/static-server.js';
import { BrowserSession } from '../browser/session.js';
import { discoverActions, type Action } from './actions.js';

let cases: StaticServer;
let kiosk: StaticServer;
let session: BrowserSession;

beforeAll(async () => {
  cases = await serveFolder('fixtures/explore-cases');
  kiosk = await serveFolder('fixtures/kiosk-app');
  session = await new BrowserSession().start();
});

afterAll(async () => {
  await session?.close();
  await cases?.close();
  await kiosk?.close();
});

const summary = (actions: Action[]) => actions.map((a) => `${a.kind} ${a.role} "${a.label}"`);

describe('discoverActions', () => {
  it('finds every kind of interactive element and nothing else', async () => {
    const opened = await session.newPage('desktop');
    await opened.page.goto(cases.url + 'actions.html');
    const actions = await discoverActions(opened.page);
    expect(summary(actions)).toEqual([
      'click link "Plain link"',
      'click button "Button with inner span"',
      'click button "Close dialog"',
      'click button "ARIA button"',
      'click generic "Div with onclick property"',
      'click generic "Div with onclick attribute"',
      'click generic "Pointer card Whole card is clickable"',
      'click generic "Focusable div"',
      'fill textbox "Email"',
      'select combobox "Topic"',
      'click checkbox "I agree"',
      'click button "Repeat"',
      'click button "Repeat"',
    ]);
    // Same-labelled actions get distinct, stable keys.
    expect(actions.filter((a) => a.label === 'Repeat').map((a) => a.key)).toEqual(['button|Repeat|0', 'button|Repeat|1']);
    expect(actions[0].href).toBe(cases.origin + '/elsewhere.html');
    expect(actions.find((a) => a.label === 'Email')).toMatchObject({ selector: '#email', inputType: 'email' });
    // Every selector finds exactly its element.
    for (const action of actions) await expect(opened.page.locator(action.selector).count()).resolves.toBe(1);
    await opened.close();
  });

  it('lists every action on kiosk-app screens', async () => {
    const opened = await session.newPage('kiosk-landscape');
    await opened.page.goto(kiosk.url);
    expect(summary(await discoverActions(opened.page))).toEqual(['click button "Museum of Making Touch anywhere to begin"']);

    await opened.page.getByRole('button').click();
    expect(summary(await discoverActions(opened.page))).toEqual([
      'click button "Home"',
      'click button "Explore the galleries"',
      'click button "Our collection"',
      'click button "Plan your visit"',
      'click button "Share your visit"',
    ]);

    await opened.page.getByRole('button', { name: 'Our collection' }).click();
    await opened.page.getByRole('button', { name: 'Paintings' }).click();
    expect((await discoverActions(opened.page)).map((a) => a.label)).toEqual(['Back', 'Home', 'Zoom in']);

    await opened.page.getByRole('button', { name: 'Back' }).click();
    await opened.page.getByRole('button', { name: 'Back' }).click();
    await opened.page.getByRole('button', { name: 'Plan your visit' }).click();
    await opened.page.getByRole('button', { name: 'Opening times' }).click();
    expect(await discoverActions(opened.page)).toEqual([]);
    await opened.close();
  });
});
