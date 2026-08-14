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

module.exports = {
  COURSE_URL:
    argValue("url") ||
    process.env.DIKSHA_COURSE_URL ||
    "https://learning.diksha.gov.in/diksha/course.php?id=1544&section=3096&modeActive=10351",

  CHROME_PATH: resolveChromePath(),
  LOCAL_DIR,
  PROFILE_DIR: process.env.DIKSHA_PROFILE_DIR || path.join(LOCAL_DIR, "diksha-profile"),
  PROGRESS_FILE: path.join(LOCAL_DIR, "progress.json"),
  REPORT_TXT: path.join(LOCAL_DIR, "diksha-diagnostic.txt"),
  REPORT_JSON: path.join(LOCAL_DIR, "diksha-diagnostic.json"),

  PLAYBACK_RATE: Number(process.env.DIKSHA_SPEED || 1.0),

  LOG_LEVEL: process.env.DIKSHA_LOG_LEVEL || "info",

  NAV_TIMEOUT_MS: 30000,
  SETTLE_MS: 2500,
  LOGIN_WAIT_MS: 300000,
  VIDEO_STALL_MS: 60000,
  VIDEO_MAX_MS: 3 * 60 * 60 * 1000,
  PROGRESS_SETTLE_MS: 15000,
  MAX_MODULES: 200,
  MAX_IDLE_PASSES: 8,
  MAX_RETRIES_PER_MODULE: 3,
  MAX_ITEMS_PER_SECTION: 150,

  INCLUDE_PATTERNS: ["\\bview\\b", "\\bstart\\b", "\\bresume\\b", "\\bcontinue\\b"],
  EXCLUDE_PATTERNS: [
    "view all", "view more", "view profile", "view grade",
    "viewed", "logout", "sign out", "download",
  ],
};
