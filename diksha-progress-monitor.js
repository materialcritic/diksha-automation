const puppeteer = require("puppeteer");
const path = require("path");

const COURSE_URL =
  "https://learning.diksha.gov.in/diksha/course.php?id=1544&section=3096&modeActive=10351";
const PROFILE_DIR = path.join(process.env.HOME, "diksha-automation", "diksha-profile");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findViewButton(page) {
  try {
    // First try main frame
    const result = await page.evaluateHandle(() => {
      const candidates = [...document.querySelectorAll("button, a, [role='button']")];
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || "").toLowerCase();
        if (text.includes("view")) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
          if (visible && !disabled) return el;
        }
      }
      return null;
    });

    const element = result.asElement();
    if (element) return { frame: page.mainFrame(), element };
    await result.dispose();
  } catch (e) {
    // Ignore
  }

  // Try iframes as fallback
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const buttons = await frame.$$("button, a");
      for (const btn of buttons) {
        const text = await frame.evaluate((el) => (el.innerText || el.textContent || "").toLowerCase()).catch(() => "");
        if (text.includes("view")) {
          const visible = await frame.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          }).catch(() => false);
          if (visible) return { frame, element: btn };
        }
      }
    } catch (e) {
      // Ignore frame errors
    }
  }
  return null;
}

async function findVideo(page) {
  for (const frame of page.frames()) {
    try {
      const handle = await frame.$("video");
      if (handle) return { frame, handle };
    } catch (e) {
      // Ignore frame errors
    }
  }
  return null;
}

async function setupAndPlayVideo(page) {
  const found = await findVideo(page).catch(() => null);
  if (!found) return null;

  const { frame, handle } = found;
  try {
    await frame.evaluate((video) => {
      video.muted = true;
      video.playbackRate = 1.5;
      if (video.paused) {
        video.play().catch(() => {});
      }
    }, handle);
    console.log("[VIDEO] Configured: muted, 1.5x speed, playing");
    return { frame, handle };
  } catch (e) {
    console.log("[VIDEO] Setup failed:", e.message);
    await handle.dispose().catch(() => {});
    return null;
  }
}

async function goBackIfNeeded(page) {
  try {
    const canGoBack = await page.evaluate(() => window.history.length > 1);
    if (canGoBack) {
      console.log("[NAV] Going back to module list...");
      await Promise.race([
        page.goBack({ waitUntil: "networkidle0", timeout: 15000 }),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]).catch(() => {});
      await delay(2000);
      return true;
    }
  } catch (e) {
    console.log("[NAV] Could not navigate back:", e.message);
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    args: ["--start-maximized"],
  });
  const [page] = await browser.pages();
  page.setDefaultTimeout(15000);
  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("✓ Monitor started. Auto-playing videos (muted, 1.5x).\n");

  let attemptCount = 0;
  const maxAttempts = 200;

  while (attemptCount < maxAttempts) {
    try {
      attemptCount++;

      // Try to play a video if one is loaded
      let videoSetup = await setupAndPlayVideo(page).catch(() => null);
      if (videoSetup) {
        const { frame, handle } = videoSetup;
        console.log(`[ATTEMPT ${attemptCount}] Video playing. Waiting for completion...`);
        try {
          await frame.waitForFunction(
            (video) => {
              const duration = video.duration;
              return video.ended || (Number.isFinite(duration) && duration > 0 && video.currentTime >= duration - 0.5);
            },
            { timeout: 0 },
            handle
          );
        } catch (e) {
          console.log("[VIDEO] Wait timed out or errored");
        }
        await handle.dispose().catch(() => {});
        console.log("[VIDEO] Completed. Waiting 6s for progress recording...");
        await delay(6000);

        // Go back to module list
        const wentBack = await goBackIfNeeded(page);
        if (wentBack) {
          console.log("[NAV] Returned to module list");
          await delay(2000);
        }
        continue;
      }

      // Scroll page to ensure all View buttons are visible
      try {
        await page.evaluate(() => window.scrollBy(0, 200));
      } catch (e) {
        // Ignore scroll errors
      }

      // Look for a "View" button to click
      const viewBtn = await findViewButton(page).catch(() => null);
      if (viewBtn) {
        console.log(`[ATTEMPT ${attemptCount}] Found View button. Clicking...`);
        try {
          await viewBtn.element.click();
          console.log("[NAV] Clicked View button. Waiting for content to load...");
          await delay(2000);
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
          await delay(3000);
          continue;
        } catch (e) {
          console.log("[ERROR] Failed to click View button:", e.message);
          await delay(1000);
        }
      }

      // No video, no view button - scroll and try again
      console.log(`[ATTEMPT ${attemptCount}] No content found. Scrolling page...`);
      try {
        await page.evaluate(() => window.scrollBy(0, 300));
      } catch (e) {
        // Ignore
      }
      await delay(1500);

    } catch (e) {
      console.log(`[ERROR] Attempt ${attemptCount}:`, e.message);
      await delay(2000);
    }
  }

  console.log(`\n✓ Completed ${maxAttempts} attempts. Course progression finished.`);
  process.exit(0);
})().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
