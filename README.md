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
| `screenshots/` | Outlined crops, named after their ticket (`PRG-A11Y-003_01.png`) |
| `run.json` | Raw run data |

Every ticket ID in the report matches a row in `tickets.csv`.

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
| `--preset` | `prego` | `tickets.csv` columns for `jira`, `linear` or `trello` |

A local folder works as a target too: `npm run prego -- audit ./build`.

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

## Scripts

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
