const os = require("os");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = __dirname;
const LOCAL_DIR = process.env.DIKSHA_LOCAL_DIR || path.join(REPO_ROOT, ".local");

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
};

function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// `--pick` forces the course picker even when a URL was supplied.
const FORCE_PICK = process.argv.includes("--pick");
const EXPLICIT_COURSE_URL = FORCE_PICK
  ? null
  : argValue("url") || process.env.DIKSHA_COURSE_URL || null;

const cfg = {
  // There is deliberately no default course. A null COURSE_URL means "ask the
  // user which course to work on" — a hardcoded default was the reason every
  // cold start and every crash-recovery bounced back to the same NEP course
  // regardless of what the user was actually working through.
  COURSE_URL: EXPLICIT_COURSE_URL,
  COURSE_URL_EXPLICIT: Boolean(EXPLICIT_COURSE_URL),
  COURSE_LISTING_URL:
    process.env.DIKSHA_COURSE_LISTING_URL ||
    "https://learning.diksha.gov.in/diksha/course_listing.php",

  CHROME_PATH: resolveChromePath(),
  LOCAL_DIR,
  PROFILE_DIR: process.env.DIKSHA_PROFILE_DIR || path.join(LOCAL_DIR, "diksha-profile"),
  PROGRESS_FILE: path.join(LOCAL_DIR, "progress.json"),
  REPORT_TXT: path.join(LOCAL_DIR, "diksha-diagnostic.txt"),
  REPORT_JSON: path.join(LOCAL_DIR, "diksha-diagnostic.json"),

  PLAYBACK_RATE: Number(process.env.DIKSHA_SPEED || 5.0),

  LOG_LEVEL: process.env.DIKSHA_LOG_LEVEL || "info",

  NAV_TIMEOUT_MS: 30000,
  // Opening a video is a same-page modal on this platform (confirmed live:
  // the URL never changes) — waiting the full NAV_TIMEOUT_MS here just
  // delays muting the video by up to 30s while it plays unmuted at 1x.
  // PDFs do navigate, but land well within this window.
  CLICK_NAV_TIMEOUT_MS: 6000,
  SETTLE_MS: 1000,
  // Wait after a video/PDF ends, before navigating back to the course list.
  POST_CONTENT_SETTLE_MS: Number(process.env.DIKSHA_POST_CONTENT_SETTLE_MS || 20000),
  LOGIN_WAIT_MS: 300000,
  VIDEO_STALL_MS: 60000,
  VIDEO_MAX_MS: 3 * 60 * 60 * 1000,
  PROGRESS_SETTLE_MS: 15000,
  MAX_MODULES: 200,
  MAX_IDLE_PASSES: 8,
  MAX_RETRIES_PER_MODULE: 3,
  MAX_ITEMS_PER_SECTION: 150,

  // Accordion sections are populated by an async request after the header is
  // clicked. A fixed sleep was too short — confirmed live, a View button stayed
  // invisible to findClickable through six expansion cycles and only appeared
  // after a ~33s pause. Poll for the DOM to stop growing instead.
  SECTION_SETTLE_MS: Number(process.env.DIKSHA_SECTION_SETTLE_MS || 6000),
  MAX_SECTIONS_PER_PAGE: 40,
  // How many times a control may be clicked without producing a video or a PDF
  // before it's recorded as a failed module.
  MAX_OPEN_ATTEMPTS: 5,

  // PDF.js viewer (DIKSHA serves readings/PPTs through vendor/pdf-viewer/web/viewer.html).
  PDF_PAGE_DELAY_MS: Number(process.env.DIKSHA_PDF_PAGE_DELAY_MS || 1500),
  PDF_STALL_MS: 60000,
  PDF_MAX_MS: 60 * 60 * 1000,

  INCLUDE_PATTERNS: ["\\bview\\b", "\\bstart\\b", "\\bresume\\b", "\\bcontinue\\b"],
  EXCLUDE_PATTERNS: [
    "view all", "view more", "view profile", "view grade",
    "viewed", "logout", "sign out", "download",
  ],
};

// The one place COURSE_URL is allowed to change. Course cards on the listing
// page carried absolute hrefs when directly inspected live, but resolving
// against the listing URL here is a harmless no-op in that case and a real
// fix if that markup ever changes — page.goto() rejects a relative URL.
cfg.setCourseUrl = function setCourseUrl(url) {
  if (!url || !String(url).trim()) throw new Error("setCourseUrl: empty URL");
  cfg.COURSE_URL = new URL(String(url).trim(), cfg.COURSE_LISTING_URL).href;
  return cfg.COURSE_URL;
};

module.exports = cfg;
