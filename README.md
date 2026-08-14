# DIKSHA Automation

> **Disclaimer, up front, not buried:** this automates progress through a
> government training portal (DIKSHA — Dedicated Channel for Knowledge
> Sharing At Scale). Automating course completion generally violates the
> platform's terms of service, and on a government training portal the
> completion record is the whole point of the exercise. The certificate is
> meant to attest that a person actually engaged with the material. Use only
> on your own account, understand the risk, and understand that a completion
> record produced this way may not mean what it's supposed to mean.

Puppeteer automation that opens a DIKSHA course, plays each module's video to
completion, and moves on to the next unvisited module — using a persistent,
resumable, on-disk progress record.

## What this actually does (and does not do)

- **Finds and opens module content.** It searches every frame on the course
  page for a clickable control whose label matches `view`, `start`, `resume`,
  or `continue` (word-boundary matched, so "Overview"/"Preview" are correctly
  excluded), and that it hasn't already completed or repeatedly failed.
- **Plays videos.** Mutes the video, sets its playback rate (default `1.0`,
  configurable), and waits for it to end — polling actual video state
  (`ended`, `currentTime`/`duration`, `error`, stalls), not a fixed sleep.
- **Tracks progress across runs.** Completed and failed module keys are
  persisted to `.local/progress.json`. Re-running the script skips what's
  already done.
- **There is no PDF handling.** Earlier versions of this README described PDF
  scrolling and generic "Next/Continue" module-advancement buttons; neither
  of those existed in the code. If the course you're running this against
  serves PDF readings, they are not currently automated — the script will
  simply not find a matching control for them and will eventually idle out.
  If you need this, it would need to be built and validated against the
  actual PDF viewer markup (run `npm run diagnose` first — see below).

## Why default speed is 1.0x, not faster

Setting `video.playbackRate` client-side is not guaranteed to be honored by
every player, and many LMS platforms validate progress against wall-clock
heartbeats rather than `video.currentTime`. If your course doesn't record
progress, the most likely cause is a mismatch between playback rate and how
the server validates watch time — try `DIKSHA_SPEED=1.0` (the default) before
assuming anything else is broken.

## Prerequisites

- Node.js 18+
- Google Chrome (or set `CHROME_PATH` to a Chromium-based browser; falls back
  to Puppeteer's bundled browser if none is found)
- A DIKSHA account with access to the target course

## Installation

```bash
git clone https://github.com/materialcritic/diksha-automation
cd diksha-automation && npm install
```

## Usage

### Run the monitor

```bash
cd diksha-automation && npm start
```

On first run, Chrome opens with a fresh profile at `.local/diksha-profile`
(gitignored — never committed). If you're not logged in, the script prints a
prompt and waits up to 5 minutes for you to log in manually in the browser
window. After that, it proceeds unattended: find content → play/wait →
record progress → find next content → repeat, until it runs out of new
content or hits the module budget (`MAX_MODULES`, default 200).

### Run the diagnostic

```bash
cd diksha-automation && npm run diagnose
```

Walks every frame on the course page (not just the main document — DIKSHA's
video content frequently lives in an iframe) and writes a report to
`.local/diksha-diagnostic.txt` (human-readable) and
`.local/diksha-diagnostic.json` (machine-readable). The report includes a
`MONITOR CANDIDATE MATCHES` section per frame showing exactly which elements
the monitor's own include/exclude patterns would pick up — use this first
when the monitor isn't finding something it should. Pass `--keep-open` to
leave the browser open afterward instead of closing it.

## Configuration

All configuration lives in [`config.js`](config.js) and can be overridden
without editing code:

| Env var / flag | Default | Purpose |
|---|---|---|
| `--url=<url>` or `DIKSHA_COURSE_URL` | the sample course URL | target course |
| `DIKSHA_SPEED` | `1.0` | video `playbackRate` |
| `DIKSHA_PROFILE_DIR` | `.local/diksha-profile` | Chrome profile location |
| `DIKSHA_LOCAL_DIR` | `.local` | base dir for profile/progress/reports |
| `CHROME_PATH` | auto-detected | browser executable |
| `DIKSHA_LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` |

Example:

```bash
DIKSHA_SPEED=1.0 DIKSHA_LOG_LEVEL=debug node diksha-progress-monitor.js --url="https://learning.diksha.gov.in/diksha/course.php?id=..."
```

## How it works

1. **Login check** — detects a login page by URL pattern or the presence of
   a password field, and waits for you to sign in manually if needed.
2. **Priming** — scrolls the page once top-to-bottom to trigger lazy-loaded
   content, then back to the top.
3. **Main loop**, each iteration:
   - If a `<video>` element exists on the current page (any frame): mute it,
     set its rate, play it, poll for real completion (or a stall/error/
     timeout), wait for an on-page completion marker (falling back to a 6s
     sleep if none appears), record the module as completed or failed, and
     navigate back to the course list.
   - Otherwise, search every frame for the first clickable control that
     matches the include patterns, doesn't match the exclude patterns, is
     visible and enabled, and isn't already completed or exhausted its retry
     budget. Click it (falling back to a dispatched `.click()` if a real
     mouse click is intercepted by an overlay) and wait for navigation — or
     for a new tab, if the control opens one.
   - If nothing is found: return to the course list once, and if a second
     consecutive pass still finds nothing, the run ends — that's the actual
     "no more content" signal, not an iteration counter running out.
4. **Shutdown** — `Ctrl+C`, an unhandled rejection, or an uncaught exception
   all trigger the same path: save progress to disk, close the browser
   (5s timeout), exit with a signal-appropriate code.

## Files

| Path | Purpose |
|---|---|
| `diksha-progress-monitor.js` | main automation loop |
| `diksha-diagnostic.js` | per-frame page structure report |
| `config.js` | all tunables, env/flag overrides |
| `lib/browser.js` | launch, login detection, graceful shutdown |
| `lib/dom.js` | cross-frame element search, click, progress-settle polling |
| `lib/video.js` | video detection, playback, completion polling |
| `lib/progress.js` | load/save `.local/progress.json` |
| `.local/` | gitignored — profile, progress file, diagnostic reports |

## Troubleshooting

**Monitor isn't finding a module it should.** Run `npm run diagnose` and
check the `MONITOR CANDIDATE MATCHES` section for the relevant frame — it
shows the exact label text and whether it passed or failed the include/
exclude patterns. Adjust `INCLUDE_PATTERNS` / `EXCLUDE_PATTERNS` in
`config.js` accordingly.

**Video plays but progress never records.** Try `DIKSHA_SPEED=1.0` (see
above). Also check `.local/diksha-diagnostic.json` for a completion marker
class/attribute on that module and confirm it matches the selector in
`waitForProgressSettle()` (`lib/dom.js`).

**"Profile is locked" on launch.** Another Chrome process is using
`.local/diksha-profile`. Close all Chrome windows using that profile, or
delete `.local/diksha-profile/SingletonLock` if you're sure nothing is using
it.

**Logged out and the script isn't prompting.** It should detect this via URL
pattern or a password field and print a prompt with a 5-minute wait. If it
doesn't, that detection likely needs adjusting for this platform — check
`ensureLoggedIn()` in `lib/browser.js` against what the diagnostic report
shows for the login page.

## License

MIT
