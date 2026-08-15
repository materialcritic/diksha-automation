const cfg = require("./config");
const { log } = require("./lib/log");
const { launch, ensureLoggedIn, installShutdown } = require("./lib/browser");
const {
  findClickable, clickElement, expandNextModule, expandAllSections, waitForContentSettled,
  primePage, waitForCourseListReady, syncCompletedFromDom, waitForModuleComplete,
} = require("./lib/dom");
const { findVideo, configureAndPlay, waitForVideoEnd, clickPlayButtonIfPresent } = require("./lib/video");
const { findPdfViewer, readPdf } = require("./lib/pdf");
const { loadProgress, saveProgress } = require("./lib/progress");
const { resolveTrouble } = require("./lib/prompt");
const { chooseCourse, extractCourseId } = require("./lib/courses");
const pause = require("./lib/pause");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- run generations --------------------------------------------------
// onFatal fires from an unhandledRejection handler, i.e. from outside the
// await chain the loop is sitting in. The old code called main() recursively
// from there, which left the original runLoop alive and driving the same
// browser — two loops, one page. Instead each run carries a generation number;
// asking for a restart bumps it, the stale loop notices at its next checkpoint
// and returns, and the top-level driver starts a clean run.
let generation = 0;
let signalRestart = () => {};
const isStale = (gen) => gen !== generation;

// Opening a video is an in-page modal here — confirmed live, the URL never
// changes — so waiting on navigation alone means the video plays unmuted at
// full speed for however long that wait takes. Poll for either a real
// navigation or the video actually appearing, and stop as soon as either
// happens.
async function clickAndSettle(session, frame, element) {
  const before = new Set(await session.browser.pages());
  const startUrl = session.page.url();
  await clickElement(frame, element);

  const deadline = Date.now() + cfg.CLICK_NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (session.page.url() !== startUrl) break;
    const video = await findVideo(session.page).catch(() => null);
    if (video) { await video.handle.dispose().catch(() => {}); break; }
    await delay(150);
  }
  await delay(cfg.SETTLE_MS);

  const opened = (await session.browser.pages()).find((p) => !before.has(p));
  if (opened) {
    log("info", "NAV", "Content opened in a new tab; switching to it.");
    session.popup = opened;
    session.page = opened;
    session.page.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
    await opened.bringToFront().catch(() => {});
  }
}

// Reload the course page and put it back into a fully-scannable state.
// expandAllSections is the important part: page.goto collapses every accordion,
// and expanding them one-per-loop-iteration (the old shape) meant every reload
// reset idlePasses and the run could never conclude.
async function returnToCourseList(session) {
  if (session.popup) {
    await session.popup.close().catch(() => {});
    session.popup = null;
    session.page = session.rootPage;
    await session.page.bringToFront().catch(() => {});
  }
  await session.page.goto(cfg.COURSE_URL, {
    waitUntil: "domcontentloaded",
    timeout: cfg.NAV_TIMEOUT_MS,
  });
  await waitForCourseListReady(session.page);
  await primePage(session.page);
  await expandAllSections(session.page);
}

// Records a failure for `key` and, if that was its last retry, asks the user
// what to do instead of letting it be silently abandoned forever.
async function recordFailure(session, state, key, reason) {
  const count = (state.failed.get(key) || 0) + 1;
  state.failed.set(key, count);
  saveProgress(state);
  if (count < cfg.MAX_RETRIES_PER_MODULE) return "exhausted-budget-remaining";

  const choice = await resolveTrouble(
    `Module ${key} failed ${count} time(s)`,
    `Reason: ${reason}\nThis module would normally be permanently skipped now.`,
    `The browser is open on module ${key}. Fix whatever's needed (e.g. finish it manually), then continue.`
  );
  if (choice === "close") return "close";
  state.failed.delete(key);
  saveProgress(state);
  return "retry";
}

async function runLoop(session, state, gen) {
  let completedThisRun = 0, failedThisRun = 0, idlePasses = 0;
  session.currentKey = null;
  session.lastOpenedKey = null;
  session.openAttempts = 0;

  while (completedThisRun + failedThisRun < cfg.MAX_MODULES) {
    if (isStale(gen)) return { completedThisRun, failedThisRun, stale: true };

    if (pause.consumePauseRequest()) {
      const choice = await pause.pauseAndWaitForResume();
      if (choice === "close") return { completedThisRun, failedThisRun, closeRequested: true };
      continue;
    }

    if (await clickPlayButtonIfPresent(session.page)) {
      await delay(2000);
    }

    const video = await findVideo(session.page);
    if (video) {
      idlePasses = 0;
      session.openAttempts = 0;
      const key = session.currentKey;
      const ok = await configureAndPlay(video.frame, video.handle);
      let outcome = "error";
      if (ok) outcome = await waitForVideoEnd(video.frame, video.handle);
      await video.handle.dispose().catch(() => {});
      log("info", "VIDEO", `Outcome: ${outcome}`);
      if (outcome === "closed") return { completedThisRun, failedThisRun, closeRequested: true };

      await delay(cfg.POST_CONTENT_SETTLE_MS);
      await returnToCourseList(session);
      await syncCompletedFromDom(session.page, state);

      if (outcome === "ended" && key) {
        const settled = await waitForModuleComplete(session.page, key);
        if (settled.completed) {
          state.completed.add(key);
          completedThisRun++;
          saveProgress(state);
        } else {
          const decision = await recordFailure(session, state, key, `video ended but only reached ${settled.percent ?? "?"}% on DIKSHA`);
          if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
          failedThisRun++;
        }
      } else if (key) {
        const decision = await recordFailure(session, state, key, `video outcome: ${outcome}`);
        if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
        failedThisRun++;
      }
      session.currentKey = null;
      continue;
    }

    const pdf = await findPdfViewer(session.page);
    if (pdf) {
      idlePasses = 0;
      session.openAttempts = 0;
      const key = session.currentKey;
      const outcome = await readPdf(pdf);
      log("info", "PDF", `Outcome: ${outcome}`);
      if (outcome === "closed") return { completedThisRun, failedThisRun, closeRequested: true };

      await delay(cfg.POST_CONTENT_SETTLE_MS);
      await returnToCourseList(session);
      await syncCompletedFromDom(session.page, state);

      if (outcome === "ended" && key) {
        const settled = await waitForModuleComplete(session.page, key);
        if (settled.completed) {
          state.completed.add(key);
          completedThisRun++;
          saveProgress(state);
        } else {
          const decision = await recordFailure(session, state, key, `PDF finished but only reached ${settled.percent ?? "?"}% on DIKSHA`);
          if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
          failedThisRun++;
        }
      } else if (key) {
        const decision = await recordFailure(session, state, key, `PDF outcome: ${outcome}`);
        if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
        failedThisRun++;
      }
      session.currentKey = null;
      continue;
    }

    const candidate = await findClickable(session.page, state);
    if (candidate) {
      idlePasses = 0;

      // Clicking a control that produces neither a video nor a PDF leaves the
      // page unchanged, so the very same candidate is found again next pass —
      // confirmed live, the same act: key was opened three times in a row.
      // Count consecutive no-op opens and eventually record it as a failure so
      // the module can't monopolise the loop.
      if (candidate.key === session.lastOpenedKey) {
        session.openAttempts++;
      } else {
        session.lastOpenedKey = candidate.key;
        session.openAttempts = 1;
      }
      if (session.openAttempts > cfg.MAX_OPEN_ATTEMPTS) {
        log("warn", "MODULE", `"${candidate.label}" (${candidate.key}) opened ${session.openAttempts - 1}x with no video or PDF.`);
        const decision = await recordFailure(session, state, candidate.key,
          `clicked ${session.openAttempts - 1} times but no video or PDF appeared`);
        await candidate.element.dispose().catch(() => {});
        session.lastOpenedKey = null;
        session.openAttempts = 0;
        session.currentKey = null;
        if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
        failedThisRun++;
        await returnToCourseList(session);
        continue;
      }

      log("info", "MODULE", `Opening: "${candidate.label}" (${candidate.key})`);
      session.currentKey = candidate.key;
      try {
        await clickAndSettle(session, candidate.frame, candidate.element);
      } catch (err) {
        log("error", "MODULE", `Click failed: ${err.message}`);
        const decision = await recordFailure(session, state, candidate.key, `click failed: ${err.message}`);
        session.currentKey = null;
        await candidate.element.dispose().catch(() => {});
        await returnToCourseList(session);
        if (decision === "close") return { completedThisRun, failedThisRun, closeRequested: true };
        failedThisRun++;
        continue;
      }
      await candidate.element.dispose().catch(() => {});
      continue;
    }

    // Safety net only — returnToCourseList already expands everything after a
    // reload. Deliberately does NOT reset idlePasses: it used to, and combined
    // with the reload-collapses-everything behaviour that made the idle counter
    // unable to ever reach MAX_IDLE_PASSES, so the run looped forever.
    if (await expandNextModule(session.page)) {
      await waitForContentSettled(session.page);
      continue;
    }

    idlePasses++;
    if (idlePasses === 1) { await returnToCourseList(session); continue; }
    if (idlePasses < cfg.MAX_IDLE_PASSES) {
      log("debug", "IDLE", `No content found (pass ${idlePasses}/${cfg.MAX_IDLE_PASSES}).`);
      await delay(2000);
      continue;
    }

    // Scanned everything, including a full expansion sweep, and found nothing —
    // this course is very likely finished. Ask; never switch on our own.
    const currentId = extractCourseId(cfg.COURSE_URL);
    const decision = await chooseCourse(session.page, {
      title: "This course looks done — what next?",
      allowStay: true,
      currentUrl: cfg.COURSE_URL,
    });

    if (decision.action === "close") return { completedThisRun, failedThisRun, closeRequested: true };
    if (decision.action === "switch" && extractCourseId(decision.url) !== currentId) {
      cfg.setCourseUrl(decision.url);
      log("info", "COURSE", `Switching to: ${decision.title} (${cfg.COURSE_URL})`);
    } else {
      log("info", "COURSE", "Staying on the current course.");
    }
    idlePasses = 0;
    session.lastOpenedKey = null;
    session.openAttempts = 0;
    await returnToCourseList(session);
  }

  return { completedThisRun, failedThisRun, closeRequested: false, exhausted: true };
}

(async () => {
  pause.install();
  log("info", "PAUSE", "Press Escape at any time to pause; Enter to see what to do next.");

  let browser, page;
  while (true) {
    try {
      ({ browser, page } = await launch());
      break;
    } catch (err) {
      log("error", "LAUNCH", err.message);
      const choice = await resolveTrouble(
        "Could not launch Chrome",
        err.message,
        "Fix whatever's blocking the launch (e.g. close other Chrome windows using this profile), then continue."
      );
      if (choice === "close") process.exit(1);
    }
  }

  const state = loadProgress();
  const session = {
    browser, page, rootPage: page, popup: null,
    lastResult: null,
    saveProgress: () => saveProgress(state),
  };

  const shutdown = installShutdown(session, {
    onFatal: async (label, err) => {
      const choice = await resolveTrouble(
        "The app hit an unexpected error",
        `${label}: ${err && err.message}`,
        "The browser is left open as-is. Continue when you're ready."
      );
      if (choice === "close") { await shutdown(`user chose close after ${label}`, 1); return; }
      log("info", "RECOVER",
        `Restarting the automation loop on: ${cfg.COURSE_URL || "(no course chosen yet)"}`);
      signalRestart();
    },
  });

  // Returns "close" | "done" | "stale".
  async function main(gen) {
    // Land on the course if we already have one, otherwise on "My Learning" —
    // either way we need a signed-in session before anything else.
    const landing = cfg.COURSE_URL || cfg.COURSE_LISTING_URL;
    await session.page.goto(landing, { waitUntil: "domcontentloaded", timeout: cfg.NAV_TIMEOUT_MS });

    while (!(await ensureLoggedIn(session.page))) {
      const choice = await resolveTrouble(
        "Not signed in",
        "Didn't detect a successful login within the wait window.",
        "Log in in the browser window, then continue."
      );
      if (choice === "close") return "close";
    }
    if (isStale(gen)) return "stale";

    // Ask which course to work on — but ONLY when we don't have one yet.
    // A restart therefore keeps whatever was chosen earlier instead of falling
    // back to a default, which is what used to bounce recovery onto the wrong
    // course. Pass --url=... (or set DIKSHA_COURSE_URL) to skip this; pass
    // --pick to force it.
    if (!cfg.COURSE_URL) {
      const pick = await chooseCourse(session.page, {
        title: "Which course do you want to work on?",
      });
      if (pick.action === "close") return "close";
      cfg.setCourseUrl(pick.url);
      log("info", "COURSE", `Working on: ${pick.title}`);
      log("info", "COURSE", cfg.COURSE_URL);
    }
    if (isStale(gen)) return "stale";

    await returnToCourseList(session);
    await syncCompletedFromDom(session.page, state);
    saveProgress(state);

    const result = await runLoop(session, state, gen);
    session.lastResult = result;

    if (result.stale) return "stale";
    if (result.closeRequested) return "close";

    log("info", "DONE",
      `completed=${result.completedThisRun} failed=${result.failedThisRun} known=${state.completed.size} ` +
      (result.exhausted ? "(module budget exhausted)" : ""));
    if (state.failed.size) {
      log("warn", "DONE", `Failed keys: ${[...state.failed.keys()].join(", ")}`);
    }
    saveProgress(state);
    return "done";
  }

  // Top-level driver. A restart is a fresh iteration of this loop rather than a
  // recursive main() call, so stack frames don't nest and only one runLoop is
  // ever live (older ones bail on the generation check).
  while (true) {
    const gen = ++generation;
    let resolveRestart;
    const restarted = new Promise((r) => { resolveRestart = r; });
    signalRestart = () => resolveRestart("restart");

    const outcome = await Promise.race([
      main(gen).catch(async (err) => {
        log("error", "LOOP", `Run stopped: ${err && (err.stack || err.message)}`);
        const choice = await resolveTrouble(
          "The automation loop stopped with an error",
          (err && err.message) || String(err),
          "The browser is left open as-is. Continue when you're ready."
        );
        return choice === "close" ? "close" : "restart";
      }),
      restarted,
    ]);

    if (outcome === "restart" || outcome === "stale") continue;
    if (outcome === "close") { await shutdown("user chose close", 0); return; }
    break; // "done"
  }

  const result = session.lastResult || { completedThisRun: 0, failedThisRun: 0 };
  saveProgress(state);
  await browser.close().catch(() => {});
  process.exit(result.failedThisRun > 0 ? 1 : 0);
})();
