const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const { log } = require("./log");

async function launch() {
  fs.mkdirSync(cfg.LOCAL_DIR, { recursive: true });
  try {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: cfg.CHROME_PATH,
      userDataDir: cfg.PROFILE_DIR,
      defaultViewport: null,
      protocolTimeout: 180000,
      args: [
        "--start-maximized",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    page.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
    return { browser, page };
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(err.message)) {
      log("error", "LAUNCH",
        `Profile is locked. Close every Chrome window using it, or delete ${path.join(cfg.PROFILE_DIR, "SingletonLock")}`);
    }
    throw err;
  }
}

async function ensureLoggedIn(page) {
  const loggedOut = async () => {
    if (/(login|auth|signin|sso)/i.test(page.url())) return true;
    return page
      .evaluate(() => !!document.querySelector('input[type="password"]'))
      .catch(() => false);
  };

  if (!(await loggedOut())) return true;

  log("warn", "AUTH", `Not signed in. Log in manually in the Chrome window. Waiting up to ${cfg.LOGIN_WAIT_MS / 1000}s...`);
  const deadline = Date.now() + cfg.LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!(await loggedOut())) {
      log("info", "AUTH", "Signed in.");
      return true;
    }
  }
  log("error", "AUTH", "Login timed out.");
  return false;
}

function installShutdown(session) {
  let closing = false;
  const shutdown = async (reason, code) => {
    if (closing) return;
    closing = true;
    log("info", "SHUTDOWN", `Reason: ${reason}`);
    try { session.saveProgress?.(); } catch (e) { log("warn", "SHUTDOWN", `Progress save failed: ${e.message}`); }
    try {
      await Promise.race([
        session.browser.close(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (e) { log("warn", "SHUTDOWN", `Browser close failed: ${e.message}`); }
    process.exit(code);
  };

  process.on("SIGINT",  () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("unhandledRejection", (e) => shutdown(`unhandledRejection: ${e && e.message}`, 1));
  process.on("uncaughtException",  (e) => shutdown(`uncaughtException: ${e && e.message}`, 1));
  return shutdown;
}

module.exports = { launch, ensureLoggedIn, installShutdown };
