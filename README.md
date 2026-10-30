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

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Runs the Vitest suite |
| `npm run lint` | Lints with ESLint |
| `npm run typecheck` | Type-checks every package |
| `npm run build` | Compiles packages to `dist/` |
| `npm run prego -- <command>` | Runs the CLI from source |

## Layout

```
legacy/            original prototype, untouched
packages/core      audit engine: crawl, checks, tickets, exports
packages/cli       command-line wrapper around core
fixtures/          test targets with known defects
templates/         report template assets
data/              run data, database, screenshots, sessions (git-ignored)
```
