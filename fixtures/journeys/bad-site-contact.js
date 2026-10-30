const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  await page.goto('{{ORIGIN}}/index.html');
  await page.getByRole('link', { name: 'About' }).click();
  await page.getByRole('link', { name: 'Contact' }).click();
  await page.getByPlaceholder('Email address').fill('prego.test@example.com');
  const page1Promise = page.waitForEvent('popup');
  await page.goto(process.env.HOME);

  // ---------------------
  await context.close();
  await browser.close();
})();
