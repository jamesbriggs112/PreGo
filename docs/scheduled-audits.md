# Scheduled audits

`prego run <schedule file>` runs every audit in the file, one after another, exports each one and
prints a summary. Use it from cron, launchd or a CI system such as GitHub Actions. Each audit is
compared with the project's previous one, so the summary shows what's new, fixed and back again.

## The schedule file

A JSON file with a list of audits. Each audit takes the same settings as `prego audit`, in camelCase:

```json
{
  "audits": [
    {
      "project": "Acme Widgets",
      "target": "https://staging.acme.example",
      "group": "quick",
      "viewports": ["desktop", "mobile"],
      "maxPages": 50,
      "user": "staging",
      "passwordEnv": "ACME_STAGING_PASSWORD",
      "preset": "productive",
      "failOn": "High"
    }
  ]
}
```

| Setting | Meaning |
|---|---|
| `project`, `target` | Required. The project name and the address (or local folder) to audit. |
| `mode` | `crawl` (default), `explore` or `journey` (with `journey`, the recorded journey's name). |
| `group` or `checks` | A test group (`quick`, `accessibility`, `content`, `design`, `performance`, `security`, `full`) or a list of check IDs. Without either, the defaults in Settings. |
| `viewports` | `desktop` (default), `mobile`, `tablet`, `kiosk-landscape`, `kiosk-portrait`. |
| `maxPages`, `maxDepth`, `maxStates`, `perTemplate`, `all`, `include`, `exclude`, `ignoreRobots`, `sitemap`, `concurrency`, `delay`, `timeBudget`, `loginJourney` | As for `prego audit`. |
| `user`, `passwordEnv` | Basic auth for staging sites. The password is read from the environment variable `passwordEnv` names. A password in the file itself is rejected. |
| `preset` | Column preset for tickets.csv: `prego`, `jira`, `linear`, `productive` or `trello`. |
| `export` | `false` to skip the export bundle. |
| `failOn` | `Critical`, `High`, `Medium` or `Low`. Exit with code 1 if any New or Regressed ticket is at that severity or worse, so a CI run fails when something breaks. |

Prego checks the whole file before starting and lists every problem at once.

The example in `examples/scheduled/prego.schedule.json` audits the bundled fixtures:

```bash
npm run build
node packages/cli/dist/cli.js run examples/scheduled/prego.schedule.json
```

## On your Mac

Add a line to your crontab (`crontab -e`) to run every Monday at 7am. The Mac must be awake.

```
0 7 * * 1 cd /path/to/prego && /usr/local/bin/node packages/cli/dist/cli.js run my-sites.schedule.json --quiet >> data/scheduled.log 2>&1
```

## GitHub Actions

`examples/github-actions/prego-audits.yml` runs the schedule every Monday and on demand. It keeps
Prego's data folder in the Actions cache, so each run is compared with the last, uploads the exports
as a download, and writes the summary table to the run's summary page.

**Where audit data goes.** On GitHub's own runners, screenshots, HTML and findings are stored by
GitHub in the cache and the artifacts. That's fine for the fixtures and Four's own sites. For client
sites, Prego's rule is that audit data never leaves Four's machines: use a
[self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) on a Four computer
(`runs-on: self-hosted`), and remove the cache and upload steps or point them at local storage.

Passwords go in the repository's Actions secrets and are passed in through `env`, named to match
each audit's `passwordEnv`.
