const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const { log } = require("./log");

// Chrome's SingletonLock is a symlink whose target encodes "<hostname>-<pid>"
// of whatever process is holding the profile. Reading it and checking that
// PID is the difference between "this lock is stale, safe to clear" and
// "another instance is genuinely still running" — the previous version of
// this code couldn't tell the two apart and just told the user to delete the
// lock "if you're sure nothing is using it," which is exactly the ambiguity
// that let three copies of this script end up running concurrently for over
// two hours, each pegging a CPU core (root-caused from a real incident: a
// user unsure whether a prior instance had actually died deleted the lock
// and relaunched, three times over).
function inspectLock() {
  const lockPath = path.join(cfg.PROFILE_DIR, "SingletonLock");
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch (e) {
    return null; // no lock, or not a symlink -- nothing to check
  }
  const m = /-(\d+)$/.exec(target);
  const pid = m ? Number(m[1]) : null;
  if (!pid) return { alive: true, pid: null }; // unrecognized format -- be conservative

  try {
    process.kill(pid, 0); // throws without actually signaling anything
    return { alive: true, pid };
  } catch (err) {
    // ESRCH: no such process -- genuinely dead, safe to clear.
    // Anything else (e.g. EPERM): the PID exists but we can't confirm what it
    // is -- treat as alive rather than risk a false "safe to clear".
    return { alive: err.code !== "ESRCH", pid };
  }
}

function clearLock() {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.rmSync(path.join(cfg.PROFILE_DIR, f), { force: true }); } catch (e) { /* ignore */ }
  }
}

async function launch() {
  fs.mkdirSync(cfg.LOCAL_DIR, { recursive: true });

  const lock = inspectLock();
  if (lock) {
    if (lock.alive) {
      const message = lock.pid
        ? `Profile is in use by PID ${lock.pid}, which is still running. Refusing to start a second instance against the same profile — stop it first (kill ${lock.pid}), or close its Chrome window. If you're certain it's already gone despite this check, delete ${path.join(cfg.PROFILE_DIR, "SingletonLock")} manually.`
        : `Profile appears to be in use (lock present in an unrecognized format, so this couldn't confirm whether the owning process is still alive). Close any Chrome window using this profile, or delete ${path.join(cfg.PROFILE_DIR, "SingletonLock")} if you're certain nothing is using it.`;
      log("error", "LAUNCH", message);
      throw new Error(message);
    }
    log("info", "LAUNCH", `Clearing a stale profile lock (PID ${lock.pid} is no longer running).`);
    clearLock();
  }

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

// SIGINT/SIGTERM are an explicit "stop now" from the user, so those still
// close immediately. An unhandledRejection/uncaughtException means the app
// itself hit something it doesn't know how to handle — rather than quitting
// the Chrome window on its own, that's handed to `onFatal` (if provided),
// which is expected to show the user a choice and keep the browser open
// unless they actually choose to close it.
function installShutdown(session, { onFatal } = {}) {
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

  const handleFatal = async (label, err) => {
    if (closing) return;
    const message = (err && err.message) || String(err);
    log("error", "FATAL", `${label}: ${message}`);
    if (onFatal) {
      try {
        await onFatal(label, err);
        return;
      } catch (recoveryErr) {
        log("error", "FATAL", `Recovery itself failed: ${recoveryErr.message}`);
      }
    }
    await shutdown(`${label}: ${message}`, 1);
  };
  process.on("unhandledRejection", (e) => handleFatal("unhandledRejection", e));
  process.on("uncaughtException",  (e) => handleFatal("uncaughtException", e));
  return shutdown;
}

module.exports = { launch, ensureLoggedIn, installShutdown };
