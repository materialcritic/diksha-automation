const cfg = require("../config");
const { log } = require("./log");

const CLICKABLE =
  "button, a, [role='button'], input[type='button'], input[type='submit']";

// DIKSHA specifics learned from live inspection, not assumption:
// - Every "View" control shares href="javascript:void(0);" — using href as an
//   identity key would collide across every module. The real stable identity
//   is the act_id/data-id attribute (present on the button itself for
//   unlocked items, or on the nearest ancestor with [data-id] otherwise).
// - Locked/not-yet-available controls use class="faded ... view-disabled-btn"
//   with no native disabled property and no aria-disabled attribute, so a
//   disabled check limited to those two would click straight through a lock.
// - Each row carries a real completion signal: a `.module-progress-pie`
//   element with title="N%" (and a `.fa-check` icon once N reaches 100),
//   independent of anything this script writes to disk.
// Gathers every matching candidate in the frame in one pass (as serializable
// data, tagging each element with a unique data-diksha-key attribute so it
// can be re-selected afterward), then in Node picks the first one not already
// completed/exhausted and re-acquires a live handle for just that one. Doing
// this in two passes — rather than returning the first DOM match directly —
// means an already-completed item at the front of the list doesn't cause the
// whole frame to be given up on; the next candidate in the same frame is
// still reachable.
async function findClickable(page, { completed, failed }) {
  for (const frame of page.frames()) {
    let candidates;
    try {
      candidates = await frame.evaluate(
        (selector, includes, excludes, frameUrl) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const inc = includes.map((p) => new RegExp(p, "i"));
          const exc = excludes.map((p) => new RegExp(p, "i"));
          const nodes = [...document.querySelectorAll(selector)];
          const out = [];

          nodes.forEach((el, i) => {
            const label =
              norm(el.textContent) ||
              norm(el.getAttribute("aria-label")) ||
              norm(el.getAttribute("title")) ||
              norm(el.value);
            if (!label) return;
            if (!inc.some((r) => r.test(label))) return;
            if (exc.some((r) => r.test(label))) return;

            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible =
              rect.width > 0 && rect.height > 0 &&
              style.visibility !== "hidden" && style.display !== "none" &&
              style.opacity !== "0";
            const nativeDisabled =
              el.disabled === true || el.getAttribute("aria-disabled") === "true";
            const classDisabled = /\b(disabled|faded|view-disabled-btn|locked)\b/i.test(
              typeof el.className === "string" ? el.className : ""
            );
            if (!visible || nativeDisabled || classDisabled) return;

            const actId =
              el.getAttribute("data-id") ||
              el.getAttribute("act_id") ||
              el.closest("[data-id]")?.getAttribute("data-id") ||
              null;
            const href = el.getAttribute("href") || "";
            const realHref = href && !/^javascript:/i.test(href) && href !== "#";
            const key = actId
              ? `act:${actId}`
              : realHref
              ? `href:${new URL(href, location.href).href}`
              : `lbl:${frameUrl}|${label.slice(0, 80)}|${i}`;

            // DOM completion truth takes precedence over anything on disk.
            // The pie lives in a *sibling* <li> under the shared action-list
            // container, not inside the button's own <li> — so the search
            // scope has to be that shared container, not the button's parent.
            const container =
              el.closest(".module-action-btns, .courses_modules_desc, .modules_accordian_content") ||
              el.parentElement;
            const pie = container ? container.querySelector(".module-progress-pie [title]") : null;
            let domPercent = null;
            let domCompleted = false;
            if (pie) {
              const m = /(\d+)\s*%/.exec(pie.getAttribute("title") || "");
              if (m) domPercent = Number(m[1]);
              domCompleted = domPercent >= 100 || !!pie.querySelector(".fa-check");
            }
            if (domCompleted) return;

            el.setAttribute("data-diksha-key", key);
            out.push({ key, label: label.slice(0, 80) });
          });
          return out;
        },
        CLICKABLE,
        cfg.INCLUDE_PATTERNS,
        cfg.EXCLUDE_PATTERNS,
        frame.url()
      );
    } catch (err) {
      log("debug", "DOM", `Frame scan failed (${frame.url()}): ${err.message}`);
      continue;
    }

    const pick = candidates.find(
      (c) => !completed.has(c.key) && (failed.get(c.key) || 0) < cfg.MAX_RETRIES_PER_MODULE
    );
    if (!pick) continue;

    const handle = await frame
      .evaluateHandle(
        (k) => [...document.querySelectorAll("[data-diksha-key]")].find((el) => el.getAttribute("data-diksha-key") === k) || null,
        pick.key
      )
      .catch(() => null);
    const element = handle && handle.asElement();
    if (!element) { if (handle) await handle.dispose().catch(() => {}); continue; }
    return { frame, element, key: pick.key, label: pick.label };
  }
  return null;
}

async function clickElement(frame, element) {
  try {
    await element.click();
    return "mouse";
  } catch (err) {
    log("debug", "DOM", `Mouse click failed (${err.message}); using el.click()`);
    await frame.evaluate((el) => el.click(), element);
    return "dispatch";
  }
}

// The course page's module accordion is populated client-side after
// DOMContentLoaded fires (confirmed live: an immediate DOM query right after
// goto({waitUntil:"domcontentloaded"}) sees zero rows). Poll for the real
// signal — at least one row with a data-id — instead of a blind sleep.
async function waitForCourseListReady(page, timeoutMs = cfg.NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const ready = await frame
        .evaluate(() => !!document.querySelector(".modules_accordian_content[data-id]"))
        .catch(() => false);
      if (ready) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("warn", "DOM", "Course list did not render within the timeout; proceeding anyway.");
  return false;
}

async function primePage(page) {
  await page.evaluate(async () => {
    const step = () => new Promise((r) => setTimeout(r, 250));
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
      window.scrollTo(0, y);
      await step();
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
}

// Scans every frame for DIKSHA's own progress-pie markers and seeds `completed`
// with anything already at 100% — so a fresh run (or a deleted progress.json)
// still recognizes work already done and starts from the first incomplete item,
// instead of relying solely on our own on-disk history.
async function syncCompletedFromDom(page, state) {
  let found = 0;
  for (const frame of page.frames()) {
    try {
      const keys = await frame.evaluate(() => {
        const pies = [...document.querySelectorAll(".module-progress-pie [title]")];
        const out = [];
        for (const pie of pies) {
          const m = /(\d+)\s*%/.exec(pie.getAttribute("title") || "");
          if (!m || Number(m[1]) < 100) continue;
          const row = pie.closest("li, .courses_modules_desc, .modules_accordian_content");
          const idHolder = row ? row.closest("[data-id]") || row.querySelector("[data-id]") : null;
          const actId = idHolder ? idHolder.getAttribute("data-id") : null;
          if (actId) out.push(`act:${actId}`);
        }
        return out;
      }).catch(() => []);
      for (const key of keys) {
        if (!state.completed.has(key)) found++;
        state.completed.add(key);
      }
    } catch (err) {
      log("debug", "DOM", `DOM sync failed (${frame.url()}): ${err.message}`);
    }
  }
  if (found) log("info", "SYNC", `Recognized ${found} module(s) already marked complete on DIKSHA.`);
  return found;
}

// Looks up the current DOM completion state for a specific module key, by
// re-scanning the (freshly-loaded) course list page. Returns null if the row
// isn't present in what's currently rendered (e.g. a different accordion
// section is expanded).
async function checkDomCompletion(page, key) {
  const actId = key.startsWith("act:") ? key.slice(4) : null;
  if (!actId) return null;
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate((id) => {
        const holder = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!holder) return null;
        const pie = holder.querySelector(".module-progress-pie [title]");
        if (!pie) return null;
        const m = /(\d+)\s*%/.exec(pie.getAttribute("title") || "");
        const percent = m ? Number(m[1]) : null;
        return { percent, completed: percent >= 100 || !!pie.querySelector(".fa-check") };
      }, actId).catch(() => null);
      if (result) return result;
    } catch (err) {
      // try next frame
    }
  }
  return null;
}

// Polls checkDomCompletion for real DIKSHA completion state after finishing a
// module, falling back to a generic on-page marker check (and finally a fixed
// sleep) if the row can't be found in the current DOM.
async function waitForModuleComplete(page, key, timeoutMs = cfg.PROGRESS_SETTLE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await checkDomCompletion(page, key);
    if (result) {
      if (result.completed) {
        log("info", "PROGRESS", `DOM confirms completion (${result.percent}%).`);
        return { completed: true, percent: result.percent };
      }
    } else {
      const marked = await page.evaluate(() =>
        !!document.querySelector(
          "[class*='completed' i], [aria-label*='complete' i], input[type='checkbox']:checked"
        )
      ).catch(() => false);
      if (marked) { log("info", "PROGRESS", "Generic completion marker detected."); return { completed: true, percent: null }; }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const final = await checkDomCompletion(page, key);
  if (final) {
    log(final.completed ? "info" : "warn", "PROGRESS", `Settled at ${final.percent}% (${final.completed ? "complete" : "incomplete"}).`);
    return final;
  }
  log("warn", "PROGRESS", "No completion signal found; treating as incomplete.");
  return { completed: false, percent: null };
}

module.exports = {
  findClickable,
  clickElement,
  primePage,
  waitForCourseListReady,
  syncCompletedFromDom,
  checkDomCompletion,
  waitForModuleComplete,
  CLICKABLE,
};
