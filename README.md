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
resumable, on-disk progress record. When a course runs out of content, it
looks up your other enrolled courses and lets you switch (never
automatically). Press Escape at any time to pause.

## What this actually does

- **Recognizes what's already done.** Every module row on the course page
  carries a real completion signal — DIKSHA's own progress-pie element,
  `title="N%"`, with a checkmark once it reaches 100%. On startup (and every
  time it returns to the course list), the script reads this directly from
  the DOM and treats anything already at 100% as done — so it naturally
  resumes from the first incomplete, unlocked module instead of restarting
  from the top. This is independent of (and takes priority over) the on-disk
  `.local/progress.json` history, which exists mainly to remember modules
  that failed repeatedly so they aren't retried forever.
- **Finds and opens module content.** It searches every frame on the course
  page for a clickable control whose label matches `view`, `start`, `resume`,
  or `continue` (word-boundary matched, so "Overview"/"Preview" are correctly
  excluded), skipping anything locked (DIKSHA marks not-yet-available items
  with a `view-disabled-btn` class rather than a native `disabled` attribute)
  or already complete per the DOM check above.
- **Plays videos.** Mutes the video, sets its playback rate (default `5.0`,
  configurable), and waits for it to end — polling actual video state
  (`ended`, `currentTime`/`duration`, `error`, stalls), not a fixed sleep.
- **Reads PDFs.** DIKSHA serves PDF readings/PPTs through a bundled Mozilla
  PDF.js viewer. The script detects it, then scrolls through the document in
  reader-sized steps, polling PDF.js's own page counter and the viewer's
  scroll position until the last page is reached — again real state, not a
  fixed sleep or a blind scroll.
- **Tracks progress across runs.** Completed and failed module keys are
  persisted to `.local/progress.json` as a secondary record; DIKSHA's own DOM
  state is the primary source of truth for "already done."

## A note on playback speed

The default is `5.0`. Setting `video.playbackRate` client-side does hold in
live testing against DIKSHA (confirmed: no player reset it back), so there's
no known mechanical reason it wouldn't work.

However, at 5x there's a **confirmed, repeatable failure mode**: two
different videos both plateaued at exactly 97% DOM-reported completion,
never reaching 100%, and neither retrying nor waiting an extra 20s after the
video ended changed the outcome (see `[PROGRESS] Settled at N%` in the log).
The exact mechanism isn't confirmed — DIKSHA's client-side JS hasn't been
read — but the consistent, identical percentage across different videos
points to something in its own tracking discounting watched time against how
much real time actually elapsed, not a timing race in this script. Modules
that hit `MAX_RETRIES_PER_MODULE` failures this way will now surface the
close/take-over/retry prompt (see "How it works" below) rather than being
silently abandoned. If a module keeps plateauing, try a lower `DIKSHA_SPEED`
(1.5 has completed cleanly in testing) for that course.

## DIKSHA's completion percentage is not monotonic

Observed live: a module previously confirmed at 100% (present in
`.local/progress.json`'s `completed` list) was later found at 94% in the
live DOM — after being reopened and not watched through, its recorded
percentage on DIKSHA's own server had *dropped*. This means "already
completed" is not a fact that, once true, stays true; opening an already-
finished module and not finishing it again can regress real progress. Two
consequences this script is built around:

- **Only the live DOM decides "already done."** The on-disk `completed`
  record is not trusted to skip a module — a stale local record saying
  "done" is deliberately not enough to hide a module the DOM currently shows
  isn't. If DIKSHA regresses something, this script will notice and redo it
  rather than silently leaving it under-credited.
- **Don't manually reopen already-completed items** while this script (or
  you) might not watch them through in that session — that's the specific
  action that caused the regression observed above.

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
window.

Once signed in, if no course was specified on the command line, it opens
your "My Learning" page, lists every enrolled course with its real
completion percentage, and asks which one to work on. It stays on that
course for the rest of the run — including after an error recovery — and
only ever changes course when you pick a new one from the end-of-course
menu. Pass `--url=...` (or set `DIKSHA_COURSE_URL`) to skip the picker and
go straight to a course; pass `--pick` to force the picker even when a URL
is set.

After that, it proceeds unattended: find content → play/wait → record
progress → find next content → repeat, until it runs out of new content or
hits the module budget (`MAX_MODULES`, default 200).

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
| `--url=<url>` or `DIKSHA_COURSE_URL` | *(none — you're asked to pick)* | skip the course picker and go straight to this course |
| `--pick` | off | force the course picker even when a URL is set |
| `DIKSHA_SPEED` | `5.0` | video `playbackRate` |
| `DIKSHA_POST_CONTENT_SETTLE_MS` | `20000` | wait after content ends before navigating away |
| `DIKSHA_SECTION_SETTLE_MS` | `6000` | how long to wait for an expanded section's content to load |
| `DIKSHA_PROFILE_DIR` | `.local/diksha-profile` | Chrome profile location |
| `DIKSHA_LOCAL_DIR` | `.local` | base dir for profile/progress/reports |
| `CHROME_PATH` | auto-detected | browser executable |
| `DIKSHA_LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` |

Example:

```bash
DIKSHA_LOG_LEVEL=debug node diksha-progress-monitor.js --url="https://learning.diksha.gov.in/diksha/course.php?id=..."
```

## How it works

1. **Login check** — detects a login page by URL pattern or the presence of
   a password field, and waits for you to sign in manually if needed.
2. **Priming** — scrolls the page once top-to-bottom to trigger lazy-loaded
   content, then back to the top.
3. **Main loop**, each iteration:
   - If a Video.js "big play button" is present (confirmed live: "Live
     Session" items wrap a YouTube embed this way, and don't populate a
     real `<video>` element — everything stays empty and unstarted — until
     that button is clicked), click it and give the embed a couple of
     seconds to actually initialize. Videos that don't use this pattern are
     unaffected; this is a no-op when the button isn't there.
   - If a `<video>` element exists on the current page (any frame): mute it,
     set its rate, play it, and poll for real completion (ended, or a
     stall/error/timeout).
   - Else if a PDF.js viewer is open: scroll through it in reader-sized
     steps, polling the real page counter and scroll position until the last
     page is reached (or a stall/error/timeout).
   - After either, return to the course list and re-read the DOM completion
     signal for that specific module (falling back to a generic on-page
     marker, then a fixed sleep, if the row isn't found) to decide whether it
     actually completed.
   - Otherwise, search every frame for the first clickable control that
     matches the include patterns, doesn't match the exclude patterns, is
     visible and enabled, isn't locked, and isn't already complete per the
     live DOM (a stale on-disk "completed" record is deliberately *not*
     enough to skip a module — see the note on DIKSHA's percentage below).
     Click it (falling back to a dispatched `.click()` if a real mouse click
     is intercepted by an overlay) and wait for navigation — or for a new
     tab, if the control opens one. If the same control gets opened
     `MAX_OPEN_ATTEMPTS` times in a row without ever producing a video or a
     PDF, it's recorded as a failure instead of being clicked forever.
   - Only the module named in the course URL's `section` param auto-expands
     on page load — everything else sits collapsed and invisible to the
     search above. Every page load (including every return to the course
     list) is followed by a full expansion sweep: each still-collapsed
     accordion header is clicked in turn (skipping non-content sections like
     "Course Overview," "Assessment," "Certificate") and its content is
     polled until it stops growing — a fixed sleep here was confirmed live
     to be too short, sometimes by tens of seconds — before moving to the
     next one. Because expansion happens once per page load rather than one
     section per loop iteration, "no more content" is a real, reachable
     conclusion: it's only declared after a fully-expanded page produces two
     consecutive empty scans.
4. **When something the app can't resolve on its own comes up**, it stops and
   asks instead of quitting the browser on its own. This covers: Chrome
   failing to launch, login not detected within the wait window, no content
   found after repeated scans, and a module failing all `MAX_RETRIES_PER_MODULE`
   attempts (which used to mean it was silently abandoned forever). You get
   three options in the terminal:
   - **Close the app** — saves progress, closes the browser, exits.
   - **Take over manually** — the browser stays open exactly as-is; do
     whatever's needed (log in, finish a module by hand, close a stuck
     dialog), then press Enter in the terminal to see the same menu again.
   - **Retry** — for a launch/login/idle situation, tries that step again;
     for a module that exhausted its retries, gives it a fresh retry budget
     and picks it back up.
   `Ctrl+C` is the one thing that still closes immediately — that's treated
   as an explicit "stop now," not an error the app needs to ask about.
5. **The same course menu drives two different moments**: at startup, if no
   course was given on the command line (see Usage above); and whenever the
   "no content found" scan above concludes this course is actually done —
   at which point it looks up your other enrolled courses (via "My
   Learning") with their real completion percentages and presents them as
   numbered options, alongside staying on this course, entering a URL
   directly, taking over manually, or closing. **It never switches on its
   own** — a choice always has to be made. If you pick a course, `COURSE_URL`
   is updated in memory (not written back to `config.js` or `.env`) and the
   automation loop continues against it, reusing the same browser, profile,
   and `.local/progress.json` — module keys are DIKSHA-wide activity IDs, so
   progress tracking carries over correctly across courses. A restart after
   an error keeps whatever course was already chosen rather than falling
   back to asking again or reverting to a default.
   > Course pages structure their content differently from course to
   > course — confirmed live across two courses in the same account. One
   > used `Module 1:`, `Module 2:`, ... naming; the other used `Module
   > Overview` / `Module Learning Content`. Section-expansion is written as
   > a deny-list (skip `Course Overview`/`Assessment`/`Certificate`, expand
   > everything else) specifically because of this — but courses beyond the
   > two tested may still differ in ways this hasn't encountered yet.

## Pause and resume

Press `Escape` at any time — while a video is playing, a PDF is scrolling,
or between modules — to pause. Whatever's active (video/PDF) is explicitly
paused client-side, not just abandoned mid-flight. Press `Enter` in the
terminal to bring up the same close/take-over/retry menu described above;
choosing Retry resumes exactly where it left off (the paused video/PDF
un-pauses and picks up its own polling loop again). This needs a real
terminal (a TTY) to detect the keypress — it's silently unavailable if stdin
is piped or redirected, and the rest of the script runs normally either way.

## Shutdown

`Ctrl+C` saves progress and closes the browser immediately (5s timeout on the
close itself). An unhandled rejection or uncaught exception instead goes
through the same choice menu described above (title: "The app hit an
unexpected error") — the browser is left open and, if you choose Retry, the
automation loop restarts using the same browser, profile, and whatever
course was already chosen — not a fresh launch, and not the picker again.
Internally this is a fresh run rather than a recursive restart: each run
carries a generation number, and the stale run notices at its next
checkpoint and stops on its own instead of continuing to drive the browser
alongside the new one.

## Files

| Path | Purpose |
|---|---|
| `diksha-progress-monitor.js` | main automation loop |
| `diksha-diagnostic.js` | per-frame page structure report |
| `config.js` | all tunables, env/flag overrides |
| `lib/browser.js` | launch, login detection, graceful shutdown |
| `lib/dom.js` | cross-frame element search, click, DOM completion detection |
| `lib/video.js` | video detection, playback, completion polling |
| `lib/pdf.js` | PDF.js viewer detection, page-by-page scroll polling |
| `lib/progress.js` | load/save `.local/progress.json` |
| `lib/prompt.js` | the close/take-over/retry terminal menu, course-switch menu |
| `lib/pause.js` | Escape-to-pause keypress detection |
| `lib/courses.js` | reads "My Learning" for other enrolled courses |
| `.local/` | gitignored — profile, progress file, diagnostic reports |

## Troubleshooting

**Monitor isn't finding a module it should.** Run `npm run diagnose` and
check the `MONITOR CANDIDATE MATCHES` section for the relevant frame — it
shows the exact label text and whether it passed or failed the include/
exclude patterns. Adjust `INCLUDE_PATTERNS` / `EXCLUDE_PATTERNS` in
`config.js` accordingly.

**Video plays but progress never records.** Try `DIKSHA_SPEED=1.0` (see
above). Completion is read from each row's `.module-progress-pie` element
(`title="N%"`, a `.fa-check` icon at 100%) — if DIKSHA changes this markup,
update the selector in `waitForModuleComplete()` / `checkDomCompletion()`
(`lib/dom.js`), and use `npm run diagnose` to see the current structure.

**PDF doesn't seem to be scrolling.** The PDF handling assumes DIKSHA's
bundled Mozilla PDF.js viewer (`window.PDFViewerApplication` +
`#viewerContainer`). If a course serves PDFs through a different viewer,
`findPdfViewer()` (`lib/pdf.js`) won't recognize it — run `npm run diagnose`
while that content is open to see what's actually there.

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
