# Prego v2

Automated UX, UI and accessibility audits for websites, web apps and browser-based interactives.
Prego explores a product, runs checks on every page or screen it reaches, and exports a Word report
plus a CSV of tickets that cross-reference each other. See [SPEC.md](SPEC.md) for the full specification.

The March 2025 prototype is preserved, unchanged, in [`legacy/`](legacy/).

## Requirements

- macOS (other platforms untested), Node.js 22 or later

## Setup

```bash
npm install
```

`npm install` also downloads Playwright's Chromium (about 100 MB).

## Using the GUI

```bash
npm run dev
```

This starts the API on port 4310 and the GUI on http://127.0.0.1:5173/, and opens it in your
browser. For the production build:

```bash
npm run build && npm start
```

That serves everything from http://localhost:4310/ (set `PREGO_PORT` to change it). Prego only
listens on this computer and refuses requests from other sites.

In the GUI you can create projects, start an audit, watch it live, triage tickets (edit, merge,
dismiss false positives, add notes) and export. Triage is saved per project, so it carries into
later audits. Report branding (company name, accent colour, logo) and New audit defaults are in
Settings; CLI exports use the same branding.

## Three ways to explore

| Mode | For | How |
|---|---|---|
| Site crawl | Websites and multi-page builds | Follows the sitemap and links, groups pages by template and audits a sample of each |
| Interactive exploration | Single-page apps and kiosk interactives where the URL doesn't change | Presses every control on every screen, breadth-first, and maps every screen it reaches. Raises tickets for dead ends, buttons that do nothing, content buried too deep and inconsistent Home/Back |
| Scripted journey | A specific flow, such as booking a ticket | Record it once in Playwright's recorder ("Record journey"), then Prego replays it with checks after every step |

The explorer is careful with live sites: it never presses controls on its denylist (delete, buy,
send, log out and so on, editable per project), never follows links off the site, only types the
dummy values in [`config/dummy-data.json`](config/dummy-data.json) into forms, and freezes timers
so kiosk idle resets and attract loops can't interrupt it. Mask selectors stop clocks and carousels
making one screen look like many. A recorded journey can also log in before a crawl or exploration.

Large `<canvas>` or WebGL content, which no automated tool can read, gets a "manual review
required" ticket rather than being reported as fine.

## Checks

Choose a test group or single checks per audit on the New audit form (defaults in Settings), or with
`--group` or `--checks` on the CLI. The form estimates how long the audit will take. Every check is
passive: it only loads pages a visitor could reach, and nothing is attacked.

| Check | What it covers |
|---|---|
| `axe` | Accessibility: WCAG 2.2 A and AA rules (axe-core) |
| `a11y-custom` | Keyboard traps and visible focus, reflow at 320px, 200% zoom, text spacing, touch target size, skip links, headings, landmarks, duplicate page titles |
| `ibm` | A second accessibility engine (IBM Equal Access, bundled, runs offline). Off by default; anything axe already found is left out |
| `canvas` | Large canvas or WebGL content, flagged for manual review |
| `ui` | Visual consistency: near-duplicate colours, too many greys or typefaces, text sizes, line heights and spacing a pixel apart |
| `content` | Titles, meta descriptions, Open Graph tags, unhelpful alt text |
| `spelling` | British English spelling in the main content (cspell's MIT dictionary). Dismiss a word once and it stays quiet |
| `golive` | Staging leftovers: noindex, robots.txt blocking everything, links to staging addresses, placeholder text, missing pages that return 200, no sitemap, favicon or analytics |
| `lighthouse` | Performance, best-practice and SEO scores and failing audits, one page per template. Adds several seconds per template |
| `security` | HTTPS, certificate expiry and trust, old TLS versions, security headers (CSP checked by Google's CSP Evaluator), cookie flags, mixed content, version disclosure |
| `libraries` | JavaScript libraries with published vulnerabilities (Retire.js, with a local copy of its database: `npm run update:retire-db` refreshes it) |
| `privacy` | Trackers and tracking cookies that start before cookie consent, and the outside services each template contacts |
| `html` | HTML validity (html-validate, standard preset) |
| `links` | Broken links found while crawling |
| `browsers` | Each template in Firefox and WebKit (Safari's engine), compared with Chrome. Off by default |
| `ai` | Optional AI heuristic review with Ollama on this computer (see below). Off by default |

Interactive explorations also get state map checks (dead ends, buttons that do nothing), and
journeys a ticket if a step can no longer be replayed.

Prego's browsers can't reach known advertising and analytics trackers, so audits send them nothing
and don't show up in clients' analytics.

### Tickets

Prego doesn't track tickets from one audit to the next: once exported, they're managed in the team's
own tool (the Productive preset imports straight into Productive). Each audit stands on its own.
Before exporting you can still edit a ticket's title, severity, priority and notes, merge tickets and
dismiss false positives, and those changes carry over to the project's later audits. A problem keeps
the same ticket ID every time it's found.

### Report contents

The Export page chooses what goes into report.docx, saved per audit:

- **Client-facing report** adds a contents page and your own executive summary, key findings, top
  recommendations, methodology and conclusion. Prego suggests key findings, recommendations and
  methodology from the results, so a blank section is never empty. Off gives the technical report.
- **Optional sections**, each with figures from Prego and room for your observations:
  - **Analytics**: traffic sources, devices, popular pages and countries from Google Analytics CSV
    exports, imported on the Export page and kept for the project. Prego keeps only the figures.
  - **Content and tone**: reading ease, sentence length and whether the copy talks to the reader,
    from the *Content and structure (for reports)* check.
  - **Information architecture**: how deep and flat the site is, its top-level sections and the main
    navigation. Site crawls only.
  - **Competitor analysis**: add competitor sites in the Scope and login step of the New audit form.
    Prego loads each public home page, as any visitor would, and scores it with Lighthouse at desktop
    and mobile settings alongside this site. Sites whose robots.txt asks not to are skipped.

Sections are numbered in order, and ticket section numbers in tickets.csv follow them.

### Screenshots

Exporting puts the outlined screenshots into the Word report, then deletes them from Prego. The
export has no separate screenshots folder. After that, ticket pages show no images, and exporting
the same audit again gives a report without them, so keep the first report.

### Setting up an audit by typing

The Projects page has a box for describing an audit in plain English, such as *"run an accessibility
audit on example.org, desktop and mobile"*. Prego reads it into the site, test groups, screen sizes and
page limit, matches it to an existing project where it can, and shows the settings with a time
estimate. Nothing starts until you press **Start audit**; **Change settings** opens the full form
filled in. Anything the request doesn't mention comes from the defaults in Settings.

A built-in reader handles requests phrased like the example. With AI review switched on (below), the
local Ollama model also reads looser wording, such as *"check example.org works for screen reader users
on phones"*. The site's address is always taken from what you typed, never made up by the model.

### AI review (optional)

A vision model in [Ollama](https://ollama.com), running on this computer, reviews a screenshot of
each template against Nielsen's 10 usability heuristics. Screenshots never leave the computer: Prego
refuses any Ollama address that isn't `localhost` or `127.0.0.1`. Findings are labelled
`AI-suggested` and start as `Needs review`. They stay out of scores and exports until an auditor
approves them on the ticket page.

1. Install Ollama and pull a vision model. The default, `qwen2.5vl:7b`, is Apache-2.0 licensed;
   check the licence of any other model before using it for client work.

   ```bash
   ollama pull qwen2.5vl:7b
   ```

2. In Settings, tick **Offer AI review**, press **Check Ollama**, and save.
3. Tick **AI heuristic review** on the New audit form. Expect 15 to 60 seconds per template.

## Running an audit from the command line

```bash
npm run prego -- audit https://example.org --project "Example" --viewports desktop,mobile
```

Prego crawls the site, audits up to 3 pages per template at each viewport, groups findings into
tickets and writes an export folder to `data/exports/{project}-{date}/`:

| File | What it is |
|---|---|
| `report.docx` | Readable audit report for clients and stakeholders |
| `tickets.csv` | One row per ticket, ready to import into a ticketing tool |
| `occurrences.csv` | Every individual instance of every ticket |
| `run.json` | Raw run data |

Every ticket ID in the report matches a row in `tickets.csv`. Screenshots are inside the report, and
are deleted from Prego once it's written.

Useful options (see `npm run prego -- audit --help` for all of them):

| Option | Default | |
|---|---|---|
| `--viewports` | `desktop` | `mobile`, `tablet`, `desktop`, `kiosk-landscape`, `kiosk-portrait` |
| `--max-pages`, `--max-depth`, `--time-budget` | 100, 10, none | Crawl limits |
| `--include`, `--exclude` | | Glob patterns, e.g. `--exclude "/blog/**"` |
| `--per-template`, `--all` | 3 | Pages audited per template, or every page |
| `--concurrency`, `--delay` | 2, 500ms | Keep these gentle on live sites |
| `--ignore-robots` | off | Only for staging sites you own |
| `--user` | | Basic auth username; the password comes from `PREGO_PASSWORD` |
| `--group` | | A test group instead of single checks: `quick`, `accessibility`, `content`, `design`, `performance`, `security`, `full` |
| `--preset` | `prego` | `tickets.csv` columns for `jira`, `linear`, `productive` or `trello` |

A local folder works as a target too: `npm run prego -- audit ./build`.

Explore an interactive, or record and replay a journey:

```bash
npm run prego -- audit https://kiosk.example.org --mode explore --viewports kiosk-landscape --mask ".clock"
```

```bash
npm run prego -- journey record "Example" book-a-ticket https://example.org
```

```bash
npm run prego -- audit https://example.org --project "Example" --mode journey --journey book-a-ticket
```

Run a list of audits from a schedule file, for cron or GitHub Actions (see
[docs/scheduled-audits.md](docs/scheduled-audits.md)):

```bash
npm run prego -- run examples/scheduled/prego.schedule.json
```

Other commands:

```bash
npm run prego -- runs
```

```bash
npm run prego -- export 3 --preset jira
```

```bash
npm run prego -- verify data/exports/example-2026-10-30-0907
```

## Desktop app (optional)

Build a Mac app that runs Prego in its own window, without Terminal:

```bash
npm run desktop:build
```

It downloads Electron the first time, takes a few minutes, and writes
`packages/desktop/out/Prego-darwin-<chip>/Prego.app` (about 580 MB). Drag it to Applications.

- **Data:** the app keeps its own data in `~/Library/Application Support/Prego/data`, separate from
  this folder's `data/`. **Data → Show data folder** opens it.
- **Browsers:** the app uses Playwright's browsers already installed on the Mac (`npm install` puts
  them in `~/Library/Caches/ms-playwright`). On another Mac, run
  `npx playwright install chromium firefox webkit` once first.
- **Other Macs:** the app is built for this Mac's chip and isn't signed by Apple, so macOS asks before
  opening it the first time (right-click → Open). Signing needs a paid Apple Developer account.



| Command | What it does |
|---|---|
| `npm test` | Runs the Vitest suite |
| `npm run lint` | Lints with ESLint |
| `npm run typecheck` | Type-checks every package |
| `npm run build` | Compiles packages to `dist/` |
| `npm run prego -- <command>` | Runs the CLI from source |
| `npm run fixtures` | Serves the test fixtures for a browser |

## Layout

```
legacy/            original prototype, untouched
packages/core      audit engine: crawl, checks, tickets, exports
packages/server    Fastify API, background audit jobs, live progress
packages/web       React GUI (Vite, Tailwind, shadcn/ui components)
packages/cli       command-line wrapper around core
fixtures/          test targets with known defects
templates/         report template assets
data/              run data, database, screenshots, sessions (git-ignored)
```
