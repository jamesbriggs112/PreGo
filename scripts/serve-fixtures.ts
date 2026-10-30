// Serve the test fixtures so they can be opened in a browser: `npm run fixtures`.
import { fileURLToPath } from 'node:url';
import { serveFolder } from '@prego/core';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const badSite = await serveFolder(`${fixtures}bad-site`, { port: 4173, substituteOrigin: true });
const kiosk = await serveFolder(`${fixtures}kiosk-app`, { port: 4174 });

console.log(`bad-site:  ${badSite.url}`);
console.log(`kiosk-app: ${kiosk.url}`);
console.log('Press Ctrl+C to stop.');
