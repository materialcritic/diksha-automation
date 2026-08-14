const cfg = require("../config");
const { log } = require("./log");

// DIKSHA serves PDF readings/PPTs through a bundled Mozilla PDF.js viewer
// (vendor/pdf-viewer/web/viewer.html). It exposes window.PDFViewerApplication
// (page count, current page) and a scrollable #viewerContainer holding one
// .page div per page — both confirmed by inspecting a live DIKSHA PDF frame,
// not assumed from generic "class contains pdf" guessing.
async function findPdfViewer(page) {
  for (const frame of page.frames()) {
    try {
      const has = await frame.evaluate(
        () => !!document.getElementById("viewerContainer") && !!window.PDFViewerApplication
      );
      if (has) return frame;
    } catch (_) {
      // dead or cross-origin frame
    }
  }
  return null;
}

// Polls real viewer state and scrolls in reader-sized steps, mirroring the
// video module's ended/stalled/error/detached/timeout contract.
async function readPdf(frame) {
  await frame
    .waitForFunction(
      () => window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument,
      { timeout: cfg.NAV_TIMEOUT_MS }
    )
    .catch(() => {});

  const total = await frame
    .evaluate(() => window.PDFViewerApplication.pagesCount || 0)
    .catch(() => 0);
  if (!total) { log("error", "PDF", "Could not read page count."); return "error"; }
  log("info", "PDF", `Reading ${total} page(s).`);

  let lastPage = -1;
  let lastProgressAt = Date.now();
  const deadline = Date.now() + cfg.PDF_MAX_MS;

  while (Date.now() < deadline) {
    const state = await frame
      .evaluate(() => {
        const app = window.PDFViewerApplication;
        const container = document.getElementById("viewerContainer");
        return {
          page: app.page,
          total: app.pagesCount,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
        };
      })
      .catch(() => null);

    if (!state) return "detached";

    const atBottom = state.scrollTop + state.clientHeight >= state.scrollHeight - 4;
    if (state.page >= state.total && atBottom) return "ended";

    if (state.page > lastPage) {
      lastPage = state.page;
      lastProgressAt = Date.now();
    }
    if (Date.now() - lastProgressAt > cfg.PDF_STALL_MS) return "stalled";

    await frame
      .evaluate(() => {
        const c = document.getElementById("viewerContainer");
        c.scrollTop = Math.min(c.scrollTop + c.clientHeight * 0.8, c.scrollHeight);
      })
      .catch(() => {});

    await new Promise((r) => setTimeout(r, cfg.PDF_PAGE_DELAY_MS));
  }
  return "timeout";
}

module.exports = { findPdfViewer, readPdf };
