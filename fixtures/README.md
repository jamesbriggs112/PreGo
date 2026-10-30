# Test fixtures

Two small targets with known, deliberate defects. Tests audit them and check that Prego finds
each defect. If you change a fixture, update this list and the tests that depend on it.

Open them in a browser with:

```bash
npm run fixtures
```

That serves `bad-site` at http://127.0.0.1:4173/ and `kiosk-app` at http://127.0.0.1:4174/.
`bad-site` uses root-relative links and an absolute-URL sitemap, so it needs the server; opening
its files directly from disk won't work. The server replaces `{{ORIGIN}}` in text files with its own
origin, which is how `sitemap.xml` and `robots.txt` get absolute URLs.

## bad-site

A five-page brochure site for "Acme Widgets". Every page shares one header and footer. The two
news posts share a template.

| Page | How it's reached | Deliberate defects |
|---|---|---|
| All pages (shared header) | | Logo image has no `alt` (axe `image-alt`) |
| `index.html` | Start URL | Hero image has no `alt` (`image-alt`); low-contrast intro text, #aaa on white, about 2.3:1 (`color-contrast`); heading skips h1 to h3 (`heading-order`); broken link to `/products/mark-iv.html` (404); no meta description |
| `about.html` | Header link | `<html>` has no `lang` attribute (`html-has-lang`); low-contrast caption (`color-contrast`) |
| `contact.html` | Header link | Three form fields with no label at all: name input and textarea (`label`), topic select (`select-name`). An email field with a placeholder but no label, which axe accepts as a name, so it needs the custom form check (T24); no meta description |
| `news/post-1.html` | Header link | Post template: photo has no `alt` (`image-alt`); low-contrast byline, #b0b0b0 on white (`color-contrast`); heading skips h1 to h4 (`heading-order`) |
| `news/post-2.html` | **Only in `sitemap.xml`** (no page links to it) | Same post-template defects as `post-1` |

The fixture server sends no security headers, so every page lacks a Content Security Policy,
framing protection, Referrer-Policy, Permissions-Policy and nosniff (for the security check).
`index.html` also contains a deprecated `<center>` element (for the HTML validity check).

UI drift (for the UI consistency check), in `css/site.css`: two greys a shade apart (#aaaaaa and
#b0b0b0), a 15px paragraph beside 16px body text, and a link blue (#1b4f91) one shade off the
navigation blue (#1a4d8f).

Other files that exist to test crawler behaviour:

| File | Purpose |
|---|---|
| `private/admin.html` | Linked from every footer but disallowed in `robots.txt`. A crawl that respects robots must not visit it. Not one of the five pages. |
| `/products/mark-iv.html` | Doesn't exist. Linked from `index.html`; the server returns 404. |
| `sitemap.xml` | Lists the five pages, including the orphaned `news/post-2.html`. |
| `robots.txt` | Disallows `/private/` and points to the sitemap. |

Expected template groups: `index.html`, `about.html` and `contact.html` each have their own
layout; `news/post-1.html` and `news/post-2.html` form one "news post" template.

## kiosk-app

"Museum of Making: Gallery Guide", a single-URL touch interactive for a 1920×1080 landscape kiosk.
The URL never changes; screens are swapped in JavaScript.

Screen tree (17 screens):

```
attract ("Touch anywhere to begin")
└── home: Gallery Guide                      level 1 menu, Home button only
    ├── galleries                            level 2
    │   ├── ancient ── egypt, rome           level 3 → content
    │   └── industrial ── steam, textiles    level 3 → content
    ├── collection                           level 2
    │   ├── paintings                        level 3, has the do-nothing button
    │   └── sculpture                        level 3
    ├── visit                                level 2
    │   ├── opening                          level 3, DEAD END
    │   └── access                           level 3
    └── share                                level 2
        └── email-sent                       only reachable via a denylisted action
```

| Deliberate defect | Where | What Prego should do |
|---|---|---|
| Dead-end screen | `Plan your visit → Opening times` has no Back or Home button | Raise a dead-end UX ticket |
| Button that does nothing | `Our collection → Paintings → Zoom in` | Raise a "action changes nothing" UX ticket |
| Denylisted action | `Share your visit → Send to my email` | Never press it (denylist contains "send"), so `email-sent` stays unvisited |
| Idle-reset timer | 60 seconds without input returns to the attract screen | Freeze the clock so exploration isn't reset |

## explore-cases

Small single-purpose pages for the explorer and the canvas check. Each one is a deliberate case.

| Page | Used by | What it contains |
|---|---|---|
| `actions.html` | Action discovery (T18) | Every kind of interactive element (links, buttons, ARIA buttons, click handlers set as attributes and properties, pointer-cursor cards, focusable divs, form fields), plus elements that must **not** count: disabled, hidden, invisible, inside `aria-hidden`, `tabindex="-1"`, hidden inputs |
| `form.html` | Explorer safety (T20) | A form that shows back what was submitted; a "Delete account" button (label denylist); a `.danger` button (selector denylist); a `/logout` link; a link to another site. Presses of the dangerous buttons are recorded in `window.dangerousPresses` |
| `logout.html` | Explorer safety (T20) | Where the log-out link would lead (it must never be visited) |
| `clock.html` | Mask selectors (T20) | Two screens with a live clock (`#clock`) that changes every second. Unmasked, every visit looks like a new screen |
| `canvas.html` | Canvas detection (T23) | A WebGL "gallery map" filling the screen, with no accessible name or fallback: must raise a manual-review ticket |
| `canvas-small.html` | Canvas detection (T23) | A small labelled 2D chart, well under 40% of the screen: must **not** be flagged |

## journeys

| File | What it is |
|---|---|
| `bad-site-contact.js` | A journey as Playwright's code generator records it (`--target javascript`): open bad-site, click About, click Contact, type an email. `{{ORIGIN}}` is replaced with the test server's address. It also contains a popup line and a `process.env` line, which Prego must refuse to replay |
