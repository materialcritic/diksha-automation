const cfg = require("./config");
const { log } = require("./lib/log");
const { launch, ensureLoggedIn, installShutdown } = require("./lib/browser");
const {
  findClickable, clickElement, primePage, waitForCourseListReady,
  syncCompletedFromDom, waitForModuleComplete,
} = require("./lib/dom");
const { findVideo, configureAndPlay, waitForVideoEnd } = require("./lib/video");
const { findPdfViewer, readPdf } = require("./lib/pdf");
const { loadProgress, saveProgress } = require("./lib/progress");

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

(async () => {
  const { browser, page } = await launch();
  const state = loadProgress();
  const session = {
    browser, page, rootPage: page, popup: null,
    saveProgress: () => saveProgress(state),
  };
  installShutdown(session);

  await page.goto(cfg.COURSE_URL, { waitUntil: "domcontentloaded", timeout: cfg.NAV_TIMEOUT_MS });
  if (!(await ensureLoggedIn(page))) process.exit(2);
  await waitForCourseListReady(page);
  await primePage(page);
  await syncCompletedFromDom(page, state);
  saveProgress(state);

  let completedThisRun = 0, failedThisRun = 0, idlePasses = 0;

  while (completedThisRun + failedThisRun < cfg.MAX_MODULES) {
    const video = await findVideo(session.page);
    if (video) {
      idlePasses = 0;
      const key = session.currentKey;
      const ok = await configureAndPlay(video.frame, video.handle);
      let outcome = "error";
      if (ok) outcome = await waitForVideoEnd(video.frame, video.handle);
      await video.handle.dispose().catch(() => {});
      log("info", "VIDEO", `Outcome: ${outcome}`);

      await delay(3000); // let DIKSHA's backend register the event before we navigate away
      await returnToCourseList(session);
      await syncCompletedFromDom(session.page, state);

      if (outcome === "ended" && key) {
        const settled = await waitForModuleComplete(session.page, key);
        if (settled.completed) {
          state.completed.add(key);
          completedThisRun++;
        } else {
          state.failed.set(key, (state.failed.get(key) || 0) + 1);
          failedThisRun++;
        }
      } else if (key) {
        state.failed.set(key, (state.failed.get(key) || 0) + 1);
        failedThisRun++;
      }
      saveProgress(state);
      session.currentKey = null;
      continue;
    }

    const pdf = await findPdfViewer(session.page);
    if (pdf) {
      idlePasses = 0;
      const key = session.currentKey;
      const outcome = await readPdf(pdf);
      log("info", "PDF", `Outcome: ${outcome}`);

      await delay(3000);
      await returnToCourseList(session);
      await syncCompletedFromDom(session.page, state);

      if (outcome === "ended" && key) {
        const settled = await waitForModuleComplete(session.page, key);
        if (settled.completed) {
          state.completed.add(key);
          completedThisRun++;
        } else {
          state.failed.set(key, (state.failed.get(key) || 0) + 1);
          failedThisRun++;
        }
      } else if (key) {
        state.failed.set(key, (state.failed.get(key) || 0) + 1);
        failedThisRun++;
      }
      saveProgress(state);
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
        state.failed.set(candidate.key, (state.failed.get(candidate.key) || 0) + 1);
        failedThisRun++;
        session.currentKey = null;
        await returnToCourseList(session);
      } finally {
        await candidate.element.dispose().catch(() => {});
      }
      continue;
    }

    idlePasses++;
    if (idlePasses === 1) { await returnToCourseList(session); continue; }
    if (idlePasses >= cfg.MAX_IDLE_PASSES) break;
    log("debug", "IDLE", `No content found (pass ${idlePasses}/${cfg.MAX_IDLE_PASSES}).`);
    await delay(2000);
  }

  const exhausted = completedThisRun + failedThisRun >= cfg.MAX_MODULES;
  log("info", "DONE",
    `completed=${completedThisRun} failed=${failedThisRun} known=${state.completed.size} ` +
    (exhausted ? "(module budget exhausted)" : "(no remaining content found)"));
  if (state.failed.size) {
    log("warn", "DONE", `Failed keys: ${[...state.failed.keys()].join(", ")}`);
  }
  saveProgress(state);
  await browser.close().catch(() => {});
  process.exit(exhausted || failedThisRun > 0 ? 1 : 0);
})();
