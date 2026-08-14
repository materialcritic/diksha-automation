const fs = require("fs");
const cfg = require("./config");
const { log } = require("./lib/log");
const { launch, ensureLoggedIn } = require("./lib/browser");
const { CLICKABLE } = require("./lib/dom");

const KEEP_OPEN = process.argv.includes("--keep-open");

const COLLECTOR = (selector, maxItems, includes, excludes) => {
  const clean = (v) => (v || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: clean(el.textContent),
    ariaLabel: clean(el.getAttribute("aria-label")),
    title: clean(el.getAttribute("title")),
    id: el.id || "",
    class: typeof el.className === "string" ? el.className.slice(0, 200) : "",
    role: el.getAttribute("role") || "",
    href: (el.getAttribute("href") || "").slice(0, 200),
    visible: visible(el),
  });
  const capped = (arr) => {
    const items = arr.slice(0, maxItems).map(describe);
    const omitted = arr.length - items.length;
    return { items, omitted: omitted > 0 ? omitted : 0, total: arr.length };
  };

  const buttons = capped([...document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']")]);
  const links = capped([...document.querySelectorAll("a")]);
  const videos = [...document.querySelectorAll("video")].slice(0, maxItems).map((v) => ({
    src: (v.currentSrc || v.src || "").slice(0, 200),
    duration: v.duration, currentTime: v.currentTime, paused: v.paused, ended: v.ended,
    muted: v.muted, width: v.videoWidth, height: v.videoHeight,
  }));
  const iframes = [...document.querySelectorAll("iframe")].slice(0, maxItems).map((f) => ({
    src: (f.src || "").slice(0, 200), title: f.title || "", name: f.name || "", id: f.id || "",
  }));

  const inc = includes.map((p) => new RegExp(p, "i"));
  const exc = excludes.map((p) => new RegExp(p, "i"));
  const clickables = [...document.querySelectorAll(selector)];
  const monitorMatches = [];
  for (let i = 0; i < clickables.length && monitorMatches.length < maxItems; i++) {
    const el = clickables[i];
    const label =
      clean(el.textContent) || clean(el.getAttribute("aria-label")) ||
      clean(el.getAttribute("title")) || clean(el.value);
    if (!label) continue;
    if (!inc.some((r) => r.test(label))) continue;
    const excluded = exc.some((r) => r.test(label));
    const href = el.getAttribute("href") || "";
    const key = href
      ? `href:${new URL(href, location.href).href}`
      : `lbl:${location.href}|${label.slice(0, 80)}|${i}`;
    monitorMatches.push({ label, key, excluded, visible: visible(el), ...describe(el) });
  }

  return {
    pageText: clean(document.body.innerText).slice(0, 5000),
    buttons, links, videos, iframes, monitorMatches,
  };
};

async function collectFrame(frame) {
  try {
    return await frame.evaluate(
      COLLECTOR, CLICKABLE, cfg.MAX_ITEMS_PER_SECTION, cfg.INCLUDE_PATTERNS, cfg.EXCLUDE_PATTERNS
    );
  } catch (err) {
    return { error: err.message };
  }
}

function section(title, data) {
  if (data.error) return `${title}\n${"-".repeat(title.length)}\n(frame not accessible: ${data.error})\n`;
  const lines = [`${title}\n${"-".repeat(title.length)}`];
  const listSection = (label, capped) => {
    lines.push(`\n${label} (${capped.total} total):`);
    if (!capped.items.length) { lines.push("  (none)"); return; }
    capped.items.forEach((item, i) => lines.push(`  [${i}] ${JSON.stringify(item)}`));
    if (capped.omitted) lines.push(`  ... ${capped.omitted} more omitted`);
  };
  listSection("BUTTONS", data.buttons);
  listSection("LINKS", data.links);
  lines.push(`\nVIDEOS (${data.videos.length}):`);
  data.videos.forEach((v, i) => lines.push(`  [${i}] ${JSON.stringify(v)}`));
  lines.push(`\nIFRAMES (${data.iframes.length}):`);
  data.iframes.forEach((f, i) => lines.push(`  [${i}] ${JSON.stringify(f)}`));
  lines.push(`\nMONITOR CANDIDATE MATCHES (what findClickable() would see, ${data.monitorMatches.length}):`);
  if (!data.monitorMatches.length) lines.push("  (none)");
  data.monitorMatches.forEach((m, i) => lines.push(`  [${i}] ${JSON.stringify(m)}`));
  return lines.join("\n") + "\n";
}

(async () => {
  const { browser, page } = await launch();
  log("info", "DIAG", `Opening: ${cfg.COURSE_URL}`);
  await page.goto(cfg.COURSE_URL, { waitUntil: "domcontentloaded", timeout: cfg.NAV_TIMEOUT_MS });
  await ensureLoggedIn(page);
  await new Promise((r) => setTimeout(r, 3000));

  const frames = page.frames();
  log("info", "DIAG", `Found ${frames.length} frame(s). Collecting...`);

  const frameReports = [];
  const jsonReport = { url: page.url(), title: await page.title(), frames: [] };

  for (const frame of frames) {
    const data = await collectFrame(frame);
    const label = `FRAME: ${frame.url() || "(no url)"} ${frame.name() ? `[name=${frame.name()}]` : ""}`;
    frameReports.push(section(label, data));
    jsonReport.frames.push({ url: frame.url(), name: frame.name(), ...data });
  }

  let output = "DIKSHA DIAGNOSTIC REPORT\n========================\n\n";
  output += `URL:\n${page.url()}\n\nTITLE:\n${await page.title()}\n\n`;
  output += frameReports.join("\n" + "=".repeat(60) + "\n\n");

  fs.mkdirSync(cfg.LOCAL_DIR, { recursive: true });
  fs.writeFileSync(cfg.REPORT_TXT, output, "utf8");
  fs.writeFileSync(cfg.REPORT_JSON, JSON.stringify(jsonReport, null, 2), "utf8");
  log("info", "DIAG", `Report written: ${cfg.REPORT_TXT} (${(output.length / 1024).toFixed(1)} KB)`);
  log("info", "DIAG", `JSON report: ${cfg.REPORT_JSON}`);

  if (KEEP_OPEN) {
    log("info", "DIAG", "Browser remains open (--keep-open). Press Ctrl+C to exit.");
    await new Promise(() => {});
  } else {
    await browser.close().catch(() => {});
    process.exit(0);
  }
})().catch((error) => {
  log("error", "DIAG", error.stack || error.message);
  process.exit(1);
});
