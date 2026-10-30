// Refreshes Prego's copy of the Retire.js vulnerability database (Apache-2.0, RetireJS project).
// Audits read the copy, so they never need the internet. Run: npm run update:retire-db
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v5.json';
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Couldn't download the Retire.js database: HTTP ${res.status}`);
const text = await res.text();
JSON.parse(text);
writeFileSync(new URL('../packages/core/vendor/retire/jsrepository-v5.json', import.meta.url), text);
console.log(`Saved ${Math.round(text.length / 1024)} KB, ${Object.keys(JSON.parse(text)).length} libraries.`);
