const puppeteer = require("puppeteer");
const path = require("path");

const COURSE_URL =
  "https://learning.diksha.gov.in/diksha/course.php?id=1544&section=3096&modeActive=10351";
const PROFILE_DIR = path.join(process.env.HOME, "diksha-automation", "diksha-profile");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findVideo(page) {
  for (const frame of page.frames()) {
    const handle = await frame.$("video");
    if (handle) return { frame, handle };
  }
  return null;
}

async function findPDF(page) {
  for (const frame of page.frames()) {
    const pdfViewer = await frame.$("[class*='pdf' i], [id*='pdf' i], [class*='viewer' i]");
    if (pdfViewer) return { frame, element: pdfViewer };
  }
  return null;
}

async function findNextControl(page, controlType = "module") {
  const typePatterns = {
    module: /^(next|continue|proceed|advance|proceed to next)$/i,
    pdf: /^(next page|next|continue|scroll)$/i,
    section: /^(next section|next|continue)$/i,
  };
  const pattern = typePatterns[controlType] || typePatterns.module;

  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle((labelsSource) => {
      const labels = new RegExp(labelsSource, "i");
      const candidates = [...document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")];
      return candidates.find((el) => {
        const text = [el.innerText, el.value, el.getAttribute("aria-label"), el.getAttribute("title")]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
        return labels.test(text) && enabled && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }) || null;
    }, pattern.source);
    const element = handle.asElement();
    if (element) return { frame, element };
    await handle.dispose();
  }
  return null;
}

async function scrollPDF(page) {
  const pdf = await findPDF(page);
  if (!pdf) return false;

  try {
    await pdf.frame.evaluate(() => {
      const container = document.querySelector("[class*='pdf' i], [class*='viewer' i], [class*='scroll' i]");
      if (container) {
        container.scrollTop += window.innerHeight * 0.8;
        return true;
      }
      return false;
    });
    console.log("Scrolled PDF.");
    return true;
  } catch {
    return false;
  }
}

async function setupAndPlayVideo(page) {
  const found = await findVideo(page);
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
    console.log("Video configured: muted, 1.5x speed, playing.");
    return { frame, handle };
  } catch (e) {
    console.log("Failed to configure video:", e.message);
    await handle.dispose();
    return null;
  }
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

  console.log("✓ Monitor started. Auto-playing videos (muted, 1.5x), scrolling PDFs, and advancing modules.");
  console.log("Videos will play in the background at 1.5x speed on mute.\n");

  let lastContentType = null;
  let pdfScrollCount = 0;

  while (true) {
    // Check for video
    let videoSetup = await setupAndPlayVideo(page);
    if (videoSetup) {
      const { frame, handle } = videoSetup;
      console.log("[VIDEO] Waiting for playback to finish...");
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
        console.log("Video wait timed out or errored:", e.message);
      }
      await handle.dispose();
      console.log("[VIDEO] Finished. Waiting 6 seconds for progress recording...");
      await delay(6000);
      pdfScrollCount = 0;
      lastContentType = "video";
      continue;
    }

    // Check for PDF
    const pdf = await findPDF(page);
    if (pdf && lastContentType !== "pdf") {
      console.log("[PDF] Detected. Starting to scroll through content.");
      lastContentType = "pdf";
      pdfScrollCount = 0;
    }

    if (pdf && lastContentType === "pdf") {
      const scrolled = await scrollPDF(page);
      if (scrolled) {
        pdfScrollCount++;
        console.log(`[PDF] Scrolled (pass ${pdfScrollCount}). Waiting for next page or module...`);
        await delay(3000);

        // After several scrolls, try to find next PDF button
        if (pdfScrollCount > 5) {
          const nextPdf = await findNextControl(page, "pdf");
          if (nextPdf) {
            console.log("[PDF] Next PDF button found. Advancing.");
            await nextPdf.element.click();
            await delay(2000);
            pdfScrollCount = 0;
            continue;
          }
        }
        continue;
      }
    }

    // Check for next module/section button
    const next = await findNextControl(page, "module");
    if (next) {
      console.log("[MODULE] Next button enabled. Advancing to next module.");
      await next.element.click();
      await delay(2000);
      pdfScrollCount = 0;
      lastContentType = null;
      continue;
    }

    // No video, no PDF, no next button - wait and retry
    console.log("[IDLE] Waiting for content (video, PDF, or next button)...");
    await delay(2000);
  }
})().catch((error) => {
  console.error("Monitor failed:", error);
  process.exit(1);
});
