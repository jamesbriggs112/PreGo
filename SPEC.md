# Prego v2 — Build Specification

Project: Prego v2, an automated UX, UI and accessibility audit tool
Date: 30 October 2026
Status: Draft. Review the flagged items before building.
Prepared by: James Briggs (Four) with AI assistance
Built by: Claude Code, working in this repository

---

## 1. Overview

Prego is a local desktop tool for Four's design and digital team. You point it at a digital product (a website, a web app, or a browser-based museum interactive), it explores every page or screen it can reach, runs automated UX, UI and accessibility checks on each one, and produces two linked deliverables:

1. **A Word document (.docx)**: a readable audit summary for clients and stakeholders.
2. **A CSV of tickets**: one row per issue, ready to import into a ticketing tool, so developers can fix them.

Every issue in the Word document is labelled with a ticket ID (e.g. `PRG-A11Y-014`), and the same ID is the first column of the CSV. Anyone reading either file can find the matching entry in the other.

The tool is driven through a GUI that runs in the browser at `localhost`. It uses free, open-source tools only.

The current code in this repo (a single-page Pa11y dashboard, March 2025) is a prototype. It doesn't run as is (`index.js` requires `./utils/errormapping` but the file is `errorMappings.js`, and `node-fetch` isn't installed). The crawl route is empty and meta data is never captured. v2 is a rebuild, not a patch.

---

## 2. What it must be able to audit

| Target type | Example | How Prego explores it |
|---|---|---|
| Public website | makeuk.org | **Site crawl**: follows sitemap and links |
| Staging or login-protected build | a client staging site behind basic auth or a login form | Site crawl, after logging in (see 6.3) |
| Single-page app or interactive | a museum kiosk interactive, a booking flow, a quiz | **Interactive exploration**: clicks or taps through the interface and records each distinct screen ("state") |
| Specific user journey | "book a ticket", "complete the quiz" | **Scripted journey**: recorded once, replayed with checks at every step |
| Local build | a folder of HTML/JS on disk, or a dev server on `localhost` | Prego serves the folder itself, then uses any of the above |

[ASSUMPTION: "Interactives" means browser-based (HTML/JS, including SPAs and kiosk apps running in a browser). Native apps, Unity desktop builds and Figma prototypes are out of scope. Content drawn inside `<canvas>` or WebGL can't be inspected by any accessibility engine, so Prego must detect it and raise a "manual review required" ticket rather than staying silent (see task T23).]

---

## 3. Acceptance criteria

The build is accepted when an independent person can confirm all of the following without asking anyone:

1. From a fresh clone on macOS with Node 22 or later, `npm install` followed by `npm run dev` opens the GUI in the browser with no errors. `npm run build && npm start` runs the production version.
2. Running a **site crawl** in the GUI against the bundled bad-website fixture (`fixtures/bad-site`) discovers every page in it and produces tickets for at least: missing image alt text, insufficient colour contrast, form fields without labels, missing page language, and skipped heading levels.
3. Running an **interactive exploration** against the bundled kiosk fixture (`fixtures/kiosk-app`, a single URL with no page reloads) discovers all of its screens, shows them in a state map in the GUI, and raises tickets for its deliberate dead-end screen and its button that does nothing.
4. Running a **scripted journey** recorded in the GUI replays successfully and produces findings for each step.
5. The export produces, in one folder: `report.docx`, `tickets.csv`, `occurrences.csv` and a `screenshots/` folder.
6. An automated test (`npm test`) confirms that every ticket ID in `report.docx` appears exactly once in `tickets.csv`, every ticket in `tickets.csv` is referenced in `report.docx`, and every screenshot filename in either file exists in `screenshots/`.
7. Running the same audit twice on an unchanged fixture gives identical ticket IDs. After fixing one issue in the fixture and re-running, that ticket shows as `Fixed` and the rest as `Recurring`.
8. `tickets.csv` opens in Excel and Numbers with correct characters (UTF-8 with BOM), and imports into Jira using the bundled column preset.
9. During an audit, the only outbound network requests go to the target site, its own assets, and (only if AI review is switched on) `localhost` for Ollama. A test asserts this using Playwright's request log.
10. The original prototype code is preserved, unchanged, in `/legacy`.

---

## 4. Constraint architecture

### Must do
- Use only free, open-source dependencies with permissive licences (MIT, Apache-2.0, BSD, ISC).
- Keep the audit engine (`packages/core`) separate from the GUI so it can also run from the command line and on a schedule.
- Group findings into tickets. One ticket = one problem type in one component or template, listing every place it occurs. Individual occurrences go in `occurrences.csv`.
- Give every ticket a stable ID based on a fingerprint of the problem (rule + normalised selector + page template), so IDs survive re-runs.
- Include a "Limitations and manual testing" section in every Word report.
- Let the auditor review tickets in the GUI (edit, merge, dismiss as false positive, add notes) before exporting.
- Save all run data locally (SQLite plus files on disk) inside a `data/` folder that is git-ignored.

### Must not do
- **No paid services, paid modules or freemium SaaS.** This includes axe DevTools Pro, the paid docxtemplater modules, and cloud AI APIs. Prevents: hidden costs and licence breaches.
- **No client data leaving the machine.** Screenshots, HTML and findings must never be sent to a third-party service. AI review, if used, runs locally through Ollama. Prevents: breaching client confidentiality, including for health and government clients.
- **No destructive actions by default.** Interactive exploration must not submit forms with real data, complete purchases, send messages, delete content or log out. It uses a denylist of action labels and selectors (see 6.4) and dummy test data. Prevents: real orders, emails or data changes on live client sites.
- **No hammering sites.** Default concurrency is 2 pages at once with a 500ms delay, and `robots.txt` is respected by default (switchable for staging). Prevents: Four's IP being blocked, or a client's site slowing down.
- **No compliance claims.** The report must never say a site "passes" or "is compliant with" WCAG. It reports what automated checks found. Prevents: false assurance to clients and legal exposure.
- **No one-ticket-per-occurrence.** Prevents: a 2,000-row CSV for one missing alt text pattern on a blog template.
- **No credentials in git.** Logins, cookies and saved browser sessions are stored in `data/` only. Prevents: leaking client staging credentials.
- **No home-made versions of solved problems.** Use axe-core for contrast and ARIA checks rather than writing new ones. Prevents: inaccurate results and wasted build time.

### Prefer
- When choosing between a simpler and a more powerful approach, prefer the simpler one that meets the acceptance criteria. The aim is a reliable tool, not a clever one.
- When a check can run in an existing engine (axe, Lighthouse), prefer it over a custom script.
- When a site has many pages built from the same template, prefer auditing a sample (default 3 per template) over every page, with an "audit everything" switch. This keeps runs fast and stops the report filling with duplicates.
- When writing report text, prefer plain English that a client project manager understands. Technical detail (selectors, rule IDs) goes in the CSV.
- Prefer TypeScript throughout.

### Escalate (stop and ask James)
- If a required capability has no free, permissively licensed tool. Don't substitute a paid one.
- If the Word output needs features the `docx` library can't do (for example, applying an existing branded template).
- If exploring a fixture or test site would require submitting data you can't make safe with dummy values.
- If any acceptance criterion turns out to be impossible as written. Explain why and propose an alternative rather than quietly dropping it.
- If a phase is running more than twice its estimate.

---

## 5. Technical stack (all free)

| Job | Tool | Licence |
|---|---|---|
| Runtime | Node.js 22+ (TypeScript) | MIT |
| Browser automation | Playwright | Apache-2.0 |
| Site crawling | Crawlee (`PlaywrightCrawler`) | Apache-2.0 |
| Accessibility engine | axe-core via `@axe-core/playwright` (WCAG 2.2 A and AA tags) | MPL-2.0 (file-level, fine to use) |
| Second accessibility engine (optional) | IBM `accessibility-checker` | Apache-2.0 |
| Performance, SEO, best practice | Lighthouse (programmatic) | Apache-2.0 |
| HTML validation | `html-validate` | MIT |
| Database | SQLite via `better-sqlite3` | MIT |
| API server | Fastify, with server-sent events for live progress | MIT |
| GUI | React + Vite + Tailwind + shadcn/ui | MIT |
| State map diagram | React Flow (`@xyflow/react`) | MIT |
| Word export | `docx` | MIT |
| CSV export | `csv-stringify` | MIT |
| Optional local AI review | Ollama with a local vision model | MIT |
| Desktop packaging (later, optional) | Electron | MIT |

Repository layout (npm workspaces):

```
/legacy              original prototype, untouched
/packages/core       audit engine: crawl, explore, checks, tickets, exports
/packages/server     Fastify API, job runner, live progress
/packages/web        React GUI
/packages/cli        command-line wrapper around core
/fixtures            test targets: bad-site, kiosk-app
/templates           report template assets (logo, styles)
/data                runs, database, screenshots, saved sessions (git-ignored)
```

---

## 6. How it works

### 6.1 Audit flow

1. **Set up**: choose a project (client/site), a target and an exploration mode.
2. **Explore**: crawl pages, explore interactive states, or replay journeys. Every page or state found becomes a "location".
3. **Capture**: at each location, for each chosen viewport: full-page screenshot, DOM snapshot, accessibility tree.
4. **Check**: run the enabled check modules (6.6). Each produces raw findings.
5. **Group**: raw findings are grouped into tickets by fingerprint, scored and numbered.
6. **Review**: the auditor triages tickets in the GUI.
7. **Export**: Word report + CSVs + screenshots, cross-referenced.

### 6.2 Viewports and profiles

Built-in profiles, selectable per audit:
- Mobile 375×812 (touch), Tablet 768×1024 (touch), Desktop 1440×900
- Kiosk landscape 1920×1080 (touch) and Kiosk portrait 1080×1920 (touch)
- Emulation toggles: reduced motion, forced colours (high contrast), dark mode, 200% zoom

### 6.3 Site crawl

- Seeds: start URL plus `sitemap.xml` if present.
- Stays on the same domain. Include and exclude patterns (glob).
- Limits: maximum pages (default 100), maximum depth, time budget.
- **Template grouping**: pages are grouped by a hash of their DOM structure (tags and classes, ignoring text). Prego audits up to 3 pages per template by default and records the rest as "same template, not audited".
- **Login support**: basic auth credentials, imported cookies, or a recorded login journey. The resulting browser session is saved per project in `data/`.

### 6.4 Interactive exploration (single-page apps and kiosk interactives)

For interfaces where the URL doesn't change, Prego explores by acting on the interface:

1. **Find actions**: on each screen, list everything a user can interact with (links, buttons, `role="button"`, elements with click handlers, focusable elements, elements with a pointer cursor).
2. **Identify the screen**: each state gets an ID from a hash of the URL plus the normalised accessibility tree. Volatile content (clocks, carousels, videos) is ignored using mask selectors set in the audit settings.
3. **Explore breadth-first**: perform each untried action, wait for the interface to settle, and record the new state. To reach a state again, replay the action path from the start screen.
4. **Limits**: maximum states (default 200), maximum depth (default 8), time budget.
5. **Safety**:
   - Denylist of action text and selectors, editable per project (defaults include: delete, remove, buy, pay, checkout, submit order, send, log out, sign out, unsubscribe).
   - Form fields are filled with dummy data from a config file.
   - Kiosk idle timers and attract loops are frozen using Playwright's clock control, so the app doesn't reset mid-exploration.
6. **UX findings from the state map**:
   - Dead ends: states with no way back or home
   - Actions that change nothing (likely broken buttons)
   - Content more than N taps from the start (default 4)
   - Inconsistent back or home behaviour between states

### 6.5 Scripted journeys

- "Record journey" in the GUI launches Playwright's code generator. The auditor clicks through the journey and the recording is saved to the project.
- Journeys replay with checks after every step. They're also used for logins.

### 6.6 Check modules

Each module is a plugin with the same interface: it takes a location plus a captured page, and returns raw findings.

| Module | What it checks | Source |
|---|---|---|
| Accessibility (engine) | WCAG 2.2 A/AA rules | axe-core (+ IBM checker, optional) |
| Accessibility (custom) | Keyboard tab order and visible focus at each step; reflow at 320px with no horizontal scroll; 200% zoom; text spacing; target size; skip link; heading outline; landmarks; duplicate page titles | Playwright scripts |
| UI consistency | Colours, font families, font sizes, line heights and spacing actually used across all locations, flagging near-duplicates (e.g. 23 different greys) | Computed styles |
| UX signals | Broken links and 404s; form labels, autocomplete and error messages; reading level; calls to action above the fold; plus the state map findings from 6.4 | Custom + crawl data |
| Content and SEO | Titles, meta descriptions, Open Graph, image alt quality (empty, filename-like) | Custom + Lighthouse |
| Performance and best practice | Lighthouse scores and key failures | Lighthouse |
| Security | CSP, HSTS, frame protection, referrer and permissions policies, X-Content-Type-Options, cookie flags, mixed content | Response headers (built-in `fetch`) |
| Markup | HTML validity | html-validate |
| Canvas detection | `<canvas>` or WebGL covering more than 40% of the viewport: raise a "manual review required" ticket with a screenshot | Custom |
| AI heuristic review (optional, off by default) | Nielsen's 10 heuristics, scored per screen from screenshots | Ollama, local only |

AI findings are always labelled "AI-suggested", start as `Needs review`, and are never exported unless the auditor approves them.

---

## 7. Outputs and cross-referencing

### 7.1 Ticket IDs

- Format: `PRG-{CATEGORY}-{NNN}`, for example `PRG-A11Y-014`.
- Categories: `A11Y` accessibility, `UI` visual consistency, `UX` usability, `CONT` content and SEO, `PERF` performance, `SEC` security, `TECH` markup and technical.
- Numbering is per project and never reused. A ticket's fingerprint maps to the same ID on every run.

### 7.2 Severity and priority

- **Severity**: Critical, High, Medium or Low. Taken from the axe impact level (critical, serious, moderate, minor) for axe findings, and defined in each custom rule otherwise.
- **Priority**: P1 to P4, calculated from severity × reach (share of audited locations affected) × whether the issue sits on a key journey.
- The auditor can override both in the GUI.

### 7.3 `tickets.csv` (one row per ticket)

Columns, in this order:

`Ticket ID, Title, Category, Severity, Priority, Status, WCAG criterion, WCAG level, Rule ID, Engine, Occurrences, Locations affected, Example location, Example selector, Screenshot, Description, Why it matters, Steps to reproduce, Expected, Actual, Recommendation, Effort, Report section, First seen, Last seen, Auditor notes, Labels`

- `Status` is `New`, `Recurring`, `Fixed`, `Regressed`, `Dismissed` or `Needs review`.
- `Report section` gives the Word document section the ticket appears in (e.g. `4.2`).
- `Screenshot` is a filename in `screenshots/`, always prefixed with the ticket ID (e.g. `PRG-A11Y-014_01.png`).
- Encoded as UTF-8 with BOM, comma-separated, every field quoted.
- Column presets for Jira, Linear and Trello rename the columns on export. [CONTEXT NEEDED: which ticketing tool the CSV will be imported into first. Productive.io is used at Four. Confirm whether it's the target, and get a sample import file.]

After Phase 5, a `Traffic share` column follows `Labels`: the share of visits to the pages a ticket affects, from imported analytics, with "(priority raised)" when that moved it up a level (T41).

### 7.4 `occurrences.csv` (one row per instance)

`Ticket ID, Location (URL or state ID), Viewport, Selector, HTML snippet, Screenshot crop`

### 7.5 `report.docx` structure

1. Cover: client, product, date, audit scope
2. Executive summary: a score per category, the top 5 issues by priority (each with its ticket ID), headline themes
3. Scope and method: what was audited, mode, viewports, pages or states covered, templates sampled, tools used
4. Findings by category: each theme in plain English, with ticket IDs in bold and an example screenshot with the problem outlined
5. Site map or state map summary (a diagram image for interactive audits)
6. Comparison with the previous run, if one exists
7. Limitations and manual testing: what automated checks can't cover, and recommended manual tests
8. Appendix A: full ticket index (ID, title, severity, priority, section)

[CONTEXT NEEDED: Four's branded Word template or brand assets (logo, colours, fonts) to place in `/templates`. Until they're supplied, use a clean neutral style with the logo and colours as settings.]

### 7.6 Export bundle

`data/exports/{project}-{YYYY-MM-DD-HHmm}/` containing `report.docx`, `tickets.csv`, `occurrences.csv`, `screenshots/`, `state-map.png` (interactive audits) and `run.json` (raw data). The GUI also offers a single `.zip` download.

---

## 8. GUI screens

1. **Projects**: list of clients and sites, last audit date, scores.
2. **New audit**: target URL or local folder; mode (crawl / explore / journey / combination); scope limits; login; viewports; check modules; denylist; mask selectors.
3. **Live run**: progress, locations found, current screenshot, live state map (interactive mode), stop button.
4. **Results**: score summary; filterable ticket table (category, severity, status, page); ticket detail with screenshots and every occurrence; edit, merge, dismiss and note.
5. **State map**: interactive diagram of explored states; click a state to see its screenshot and tickets.
6. **Compare**: two runs side by side, showing new, fixed and regressed tickets.
7. **Export**: choose CSV preset, preview the report, download.
8. **Settings**: branding (logo, colours, company name), defaults, Ollama on/off and model.

---

## 9. Task decomposition

Build in phase order. Each task should be a separate commit, and each phase must pass its acceptance checks before the next one starts.

### Phase 0: Foundation
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T1 | Move prototype to `/legacy`; set up npm workspaces, TypeScript, linting, test runner (Vitest) | Repo skeleton | `npm install`, `npm test` and `npm run lint` all pass on an empty project | 1.5h |
| T2 | Build fixtures: `bad-site` (5 pages with known WCAG failures, a broken link, missing meta) and `kiosk-app` (single-URL app with 3 menu levels, one dead-end screen, one button that does nothing, an idle-reset timer) | `/fixtures` | Each fixture opens in a browser; a README lists every deliberate defect | 2h |

### Phase 1: Engine and exports (CLI only)
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T3 | Data model and SQLite storage: projects, runs, locations, raw findings, tickets, occurrences | `core/db` | Unit tests create and read each entity | 1.5h |
| T4 | Browser session manager: viewports, profiles, emulation toggles, basic auth, saved sessions | `core/browser` | Opens fixtures at each profile and saves screenshots | 1.5h |
| T5 | Site crawler with Crawlee: sitemap, link discovery, limits, include/exclude, robots | `core/crawl` | Finds every page of `bad-site` | 2h |
| T6 | Template grouping and sampling | `core/crawl` | Pages built from one template group together; sampling limit respected | 1.5h |
| T7 | axe check module plus a common finding format | `core/checks/axe` | Detects the `bad-site` defects listed in acceptance criterion 2 | 1.5h |
| T8 | Screenshot capture and element crops with highlight outline | `core/capture` | Each finding has a cropped, outlined image | 1.5h |
| T9 | Grouping findings into tickets: fingerprints, stable IDs, severity, priority | `core/tickets` | Two runs give identical IDs (criterion 7, first half) | 2h |
| T10 | CSV exporter: tickets and occurrences, presets, UTF-8 BOM | `core/export/csv` | Opens cleanly in Excel; Jira preset imports | 1h |
| T11 | Word exporter: report structure from 7.5, ticket IDs, screenshots, appendix | `core/export/docx` | Report opens in Word and Pages with images | 2h |
| T12 | Cross-reference test (criterion 6) and CLI wrapper (`prego audit <url>`) | `packages/cli` + test | `npm test` passes; CLI produces a full export from `bad-site` | 1.5h |

### Phase 2: GUI
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T13 | Fastify API, background job runner, live progress via server-sent events | `packages/server` | Starting an audit via the API streams progress events | 2h |
| T14 | Projects screen and New audit form | `packages/web` | Can create a project and start a crawl from the GUI | 2h |
| T15 | Live run screen | `packages/web` | Shows progress and current screenshot; stop works | 1.5h |
| T16 | Results and ticket triage: filter, detail, edit, merge, dismiss, notes | `packages/web` | Changes made in the GUI appear in the next export | 2h |
| T17 | Export screen and Settings (branding, presets) | `packages/web` | Downloads the bundle and zip; branding appears in the report | 1.5h |

### Phase 3: Interactives and journeys
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T18 | Action discovery on a screen | `core/explore` | Lists every interactive element in `kiosk-app` | 1.5h |
| T19 | Breadth-first explorer: state IDs, replay paths, limits | `core/explore` | Finds every `kiosk-app` state | 2h |
| T20 | Safety: denylist, dummy data, clock freezing, mask selectors | `core/explore` | Denylisted fixture button is never clicked; idle reset never fires | 1.5h |
| T21 | State map UX findings and the GUI state map view | `core/explore` + `web` | Dead end and broken button raised as tickets (criterion 3); map renders | 2h |
| T22 | Journey recording (Playwright codegen) and replay with checks | `core/journeys` + `web` | Criterion 4 passes | 2h |
| T23 | Canvas and WebGL detection | `core/checks/canvas` | A canvas-heavy fixture page raises a manual-review ticket | 1h |

### Phase 4: Wider checks
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T24 | Custom accessibility checks (keyboard, focus, reflow, zoom, text spacing, target size, headings, landmarks) | `core/checks/a11y-custom` | Each check has a fixture page that triggers it | 2h |
| T25 | UI consistency module | `core/checks/ui` | Reports colour and type drift on `bad-site` | 2h |
| T26 | Lighthouse module | `core/checks/lighthouse` | Scores appear in the report | 1.5h |
| T27 | Security headers, html-validate and broken links | `core/checks/*` | Each raises tickets on the fixtures | 2h |
| T28 | IBM checker as an optional second engine, with de-duplication against axe | `core/checks/ibm` | No duplicate tickets for the same problem | 1.5h |

### Phase 5: Automation and extras
| # | Task | Output | Done when | Est. |
|---|---|---|---|---|
| T29 | Run comparison: New, Fixed, Recurring and Regressed, plus the Compare screen | `core` + `web` | Criterion 7 passes in full | 2h |
| T30 | Scheduled runs: CLI config file and an example GitHub Actions workflow | `packages/cli` + docs | Example workflow runs against a fixture | 1h |
| T31 | Optional AI heuristic review with Ollama | `core/checks/ai` | With Ollama running locally, findings appear as `Needs review`; with it off, nothing changes | 2h |
| T32 | Optional: Electron desktop packaging | `packages/desktop` | Builds a Mac `.app` that runs without Terminal | 2h |

Critical path: T1 → T2 → T3 → T4 → T5/T7 → T9 → T10/T11 → T12, then the GUI (Phase 2). Phase 3 can start once T9 is done. Phase 4 tasks are independent of each other.

### Changes after Phase 5 (agreed with James, November 2026)
| # | Change | Replaces |
|---|---|---|
| T33 | Tickets aren't tracked across audits: they're managed in the team's own tool once exported. Statuses are only `Open`, `Dismissed` and `Needs review`. The `Status`, `Screenshot`, `First seen` and `Last seen` columns, the Compare screen, report section 6 (comparison) and the Visual changes check are removed. Ticket edits, merges and dismissals stay. | T29, criterion 7 (second half), section 7.3 columns |
| T34 | Screenshots go into report.docx only. Once an export is written, the run's screenshots and crops are deleted from Prego. The bundle has no `screenshots/` folder. | Section 7.6 `screenshots/` |
| T35 | A chat box on the first page: describe an audit in plain English, Prego (with a local Ollama model, or a built-in reader) fills in the settings, and you confirm before it starts. | – |

### Phase 6: Report pack (agreed with James, November 2026)

One audit produces a pack of reports for different readers, all from the same run so they agree.
Every site has purposes, and personas and findings are tied to them, so the Overview can weigh
findings across reports. Everything stays passive (only what a visitor could load) and makes no
compliance claims. Built on `dev`, a task per commit.

| # | Task | Output | Done when |
|---|---|---|---|
| T36 ✓ | Report pack: choose which reports an audit exports. `report.docx` stays the technical report; new reports sit beside it | `core/export` + Export page | Pack choice saved per audit; each chosen report is written and listed in `run.json` |
| T37 ✓ | Overview report: scorecard (each category's score with a plain-English line), "Why a healthy website matters" (editable standard text in Settings), key findings, top recommendations, which reports to read next | `overview.docx` | A client can read the Overview in five minutes; no compliance claims |
| T38 ✓ | Purposes, personas and tasks: what the site serves now (suggested from content, navigation, forms and top GA pages) and what it should achieve (entered from the brief); personas with context, needs and device; tasks with a checkable success condition. Suggestions from a built-in reader and, if switched on, Ollama; the auditor edits or adds their own, including internal users | `core/audience` + GUI | Suggestions appear for a fixture site; edits are saved per project |
| T39 ✓ | Future readiness check: AI crawler rules in robots.txt, content and links without JavaScript, structured data, answerable content (question headings, summaries, FAQs), voice (concise answers, `speakable`, consistent contact details), entity clarity, sitemap health | `core/checks/future` + `future.docx` | Each signal has a fixture page that triggers it. `llms.txt` isn't read (not approved: sites don't usually link to it) |
| T40 ✓ | Search and sharing: how each page appears across channels. Titles and descriptions as search snippets, Open Graph and X cards as previews for LinkedIn, Facebook, X, WhatsApp and Slack, canonical, hreflang, icons, rich-result eligibility | Check + report section | Previews render for a fixture page with and without tags |
| T41 ✓ | Analytics, deeper: more GA4 exports (landing pages, key events, engagement by device) and Search Console CSV (queries, pages); findings weighted by the traffic of the pages they affect | `core/export/analytics` | Imports fixture CSVs; ticket priority reflects traffic |
| T42 ✓ | Task testing: a tree test on the crawl's link structure (does each task's target sit where its labels suggest?) and an optional Ollama walkthrough per persona and task, following only links and controls a visitor can see, never submitting forms. Scored success, partial or failed, with steps against the shortest route | `core/tasks` + `audience.docx` | Fixture tasks score as expected; the walkthrough never submits a form |
| T43 | Cross-analysis in the Overview: findings tagged with the purposes and personas they affect, and priority from severity, traffic and purpose | Overview section | A fixture audit with analytics and tasks shows a joined-up headline |

Client-facing reports carry no ticket IDs or ticket index: the report is there to persuade the client to act, and tickets.csv is for the team taking action (its Report section column still points to the matching part of the report). The technical report keeps ticket IDs throughout, and `prego verify` checks each layout accordingly.

Synthetic users aren't real users: task testing reports likely problems, labelled as an AI walkthrough, alongside proper usability testing, never instead of it.

Inspiration: Sitebulb's client reports (scores up front, prioritised hints, developer spreadsheets), squirrelscan's "agent experience" checks, Unlighthouse for site-wide Lighthouse, and UXAgent (CHI 2025) for persona-driven LLM usability testing.

---

## 10. Evaluation

**Good looks like:**
- A designer with no coding knowledge runs a full audit and exports a report without touching Terminal.
- A client PM can read the Word report and understand the top problems in five minutes.
- A developer can take any ticket ID from the report, find it in the CSV, and fix it from the information there alone.
- A 100-page site audit finishes in under 20 minutes on a recent Mac.

**Common failure modes to check for:**
- Ticket explosion: hundreds of near-identical tickets from one template. This means grouping isn't working.
- IDs that change between runs, so tickets can't be tracked.
- The explorer looping forever between two states, or missing states hidden behind modals.
- Report text that's just raw rule descriptions instead of plain English.
- Screenshots that don't show where the problem is.

---

## 11. Context and reference

- Prototype: `/legacy` (Express + Pa11y + pdfkit). Reuse the ideas (score summary, category drill-downs, export), not the code.
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- W3C "Before and After" demo, a known-bad reference site, useful as a second fixture: https://www.w3.org/WAI/demos/bad/
- axe-core rule list: https://dequeuniversity.com/rules/axe/
- Four works heavily in museums and heritage, so kiosk interactives (touch, fixed screen size, idle reset, attract loops) are a primary use case, not an edge case.
- Automated tools find only a portion of accessibility issues. The report must always present results as support for manual testing, not a replacement for it.

---

## 12. Definition of done

Phases 0 to 3 are complete when all ten acceptance criteria in section 3 pass on a clean clone. Phases 4 and 5 are done when each task's "Done when" check passes and `npm test` stays green.
