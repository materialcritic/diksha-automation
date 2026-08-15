const cfg = require("./config");
const { log } = require("./lib/log");
const { launch, ensureLoggedIn, installShutdown } = require("./lib/browser");
const {
  findClickable, clickElement, expandNextModule, primePage, waitForCourseListReady,
  syncCompletedFromDom, waitForModuleComplete,
} = require("./lib/dom");
const { findVideo, configureAndPlay, waitForVideoEnd, clickPlayButtonIfPresent } = require("./lib/video");
const { findPdfViewer, readPdf } = require("./lib/pdf");
const { loadProgress, saveProgress } = require("./lib/progress");
const { resolveTrouble } = require("./lib/prompt");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Opening a video is an in-page modal here — confirmed live, the URL never
// changes — so waiting on navigation alone means the video plays unmuted at
// full speed for however long that wait takes. Poll for either a real
// navigation or the video actually appearing, and stop as soon as either
// happens, so mute/rate get applied within a few hundred ms instead of after
// a fixed multi-second timeout.
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
}

// Records a failure for `key` and, if that was its last retry, asks the user
// what to do instead of letting it be silently abandoned forever. Returns
// true if the caller should stop trying this key for now (either it's still
// within budget and should just move on, or the user chose to close/retry
// and the caller's loop will handle that separately) — false if the user
// reset the budget and this key should be treated as immediately retryable.
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
  // retry: give it a fresh budget so findClickable will pick it up again.
  state.failed.delete(key);
  saveProgress(state);
  return "retry";
}

async function runLoop(session, state) {
  let completedThisRun = 0, failedThisRun = 0, idlePasses = 0;
  session.currentKey = null; // avoid misattributing progress to a stale key after a restart

  while (completedThisRun + failedThisRun < cfg.MAX_MODULES) {
    // "Live Session" items wrap a YouTube embed in a Video.js player that
    // doesn't populate a real <video> element until its own play button is
    // clicked — confirmed live. Harmless no-op on pages without that button.
    if (await clickPlayButtonIfPresent(session.page)) {
      await delay(2000);
    }

    const video = await findVideo(session.page);
    if (video) {
      idlePasses = 0;
      const key = session.currentKey;
      const ok = await configureAndPlay(video.frame, video.handle);
      let outcome = "error";
      if (ok) outcome = await waitForVideoEnd(video.frame, video.handle);
      await video.handle.dispose().catch(() => {});
      log("info", "VIDEO", `Outcome: ${outcome}`);

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
      const key = session.currentKey;
      const outcome = await readPdf(pdf);
      log("info", "PDF", `Outcome: ${outcome}`);

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

    // Nothing visible right now doesn't mean nothing's left — only the
    // module named in the URL auto-expands; the rest sit collapsed and
    // invisible to findClickable until their accordion header is clicked.
    if (await expandNextModule(session.page)) {
      idlePasses = 0;
      await delay(800);
      continue;
    }

    idlePasses++;
    if (idlePasses === 1) { await returnToCourseList(session); continue; }
    if (idlePasses < cfg.MAX_IDLE_PASSES) {
      log("debug", "IDLE", `No content found (pass ${idlePasses}/${cfg.MAX_IDLE_PASSES}).`);
      await delay(2000);
      continue;
    }

    const choice = await resolveTrouble(
      "No content found",
      `Scanned the course list ${cfg.MAX_IDLE_PASSES} times with nothing to do — no video, no PDF, no unvisited module. This usually means the course is actually finished, but could also mean something on the page isn't being recognized.`,
      "The browser is open on the course list. Look around, and continue when you're ready."
    );
    if (choice === "close") return { completedThisRun, failedThisRun, closeRequested: true };
    idlePasses = 0;
    await returnToCourseList(session);
  }

  return { completedThisRun, failedThisRun, closeRequested: false, exhausted: true };
}

(async () => {
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
      log("info", "RECOVER", "Restarting the automation loop.");
      await main();
    },
  });

  async function main() {
    await page.goto(cfg.COURSE_URL, { waitUntil: "domcontentloaded", timeout: cfg.NAV_TIMEOUT_MS });

    while (!(await ensureLoggedIn(session.page))) {
      const choice = await resolveTrouble(
        "Not signed in",
        "Didn't detect a successful login within the wait window.",
        "Log in in the browser window, then continue."
      );
      if (choice === "close") { await shutdown("user chose close (not logged in)", 2); return; }
    }

    await waitForCourseListReady(session.page);
    await primePage(session.page);
    await syncCompletedFromDom(session.page, state);
    saveProgress(state);

    const result = await runLoop(session, state);

    if (result.closeRequested) {
      await shutdown("user chose close", 0);
      return;
    }

    log("info", "DONE",
      `completed=${result.completedThisRun} failed=${result.failedThisRun} known=${state.completed.size} ` +
      (result.exhausted ? "(module budget exhausted)" : ""));
    if (state.failed.size) {
      log("warn", "DONE", `Failed keys: ${[...state.failed.keys()].join(", ")}`);
    }
    saveProgress(state);
    await browser.close().catch(() => {});
    process.exit(result.failedThisRun > 0 ? 1 : 0);
  }

  await main();
})();
