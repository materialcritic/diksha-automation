const cfg = require("../config");
const { log } = require("./log");

const CLICKABLE =
  "button, a, [role='button'], input[type='button'], input[type='submit']";

async function findClickable(page, { completed, failed }) {
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(
        (selector, includes, excludes, frameUrl) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const inc = includes.map((p) => new RegExp(p, "i"));
          const exc = excludes.map((p) => new RegExp(p, "i"));
          const nodes = [...document.querySelectorAll(selector)];

          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const label =
              norm(el.textContent) ||
              norm(el.getAttribute("aria-label")) ||
              norm(el.getAttribute("title")) ||
              norm(el.value);
            if (!label) continue;
            if (!inc.some((r) => r.test(label))) continue;
            if (exc.some((r) => r.test(label))) continue;

            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible =
              rect.width > 0 && rect.height > 0 &&
              style.visibility !== "hidden" && style.display !== "none" &&
              style.opacity !== "0";
            const disabled =
              el.disabled === true || el.getAttribute("aria-disabled") === "true";
            if (!visible || disabled) continue;

            const href = el.getAttribute("href") || "";
            const key = href
              ? `href:${new URL(href, location.href).href}`
              : `lbl:${frameUrl}|${label.slice(0, 80)}|${i}`;

            el.setAttribute("data-diksha-key", key);
            return el;
          }
          return null;
        },
        CLICKABLE,
        cfg.INCLUDE_PATTERNS,
        cfg.EXCLUDE_PATTERNS,
        frame.url()
      );

      const element = handle.asElement();
      if (!element) { await handle.dispose(); continue; }

      const key = await frame
        .evaluate((el) => el.getAttribute("data-diksha-key"), element)
        .catch(() => null);
      const label = await frame
        .evaluate((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80), element)
        .catch(() => "");

      if (!key || completed.has(key) || (failed.get(key) || 0) >= cfg.MAX_RETRIES_PER_MODULE) {
        await element.dispose();
        continue;
      }
      return { frame, element, key, label };
    } catch (err) {
      log("debug", "DOM", `Frame scan failed (${frame.url()}): ${err.message}`);
      if (handle) await handle.dispose().catch(() => {});
    }
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

async function waitForProgressSettle(page) {
  const deadline = Date.now() + cfg.PROGRESS_SETTLE_MS;
  while (Date.now() < deadline) {
    const marked = await page.evaluate(() =>
      !!document.querySelector(
        "[class*='completed' i], [aria-label*='complete' i], input[type='checkbox']:checked"
      )
    ).catch(() => false);
    if (marked) { log("info", "PROGRESS", "Completion marker detected."); return true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("warn", "PROGRESS", "No completion marker found; falling back to a fixed 6s wait.");
  await new Promise((r) => setTimeout(r, 6000));
  return false;
}

module.exports = { findClickable, clickElement, primePage, waitForProgressSettle, CLICKABLE };
