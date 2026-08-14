const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const COURSE_URL =
  "https://learning.diksha.gov.in/diksha/course.php?id=1544&section=3096&modeActive=10351";

const PROFILE_DIR = path.join(process.env.HOME, "diksha-automation", "diksha-profile");
const OUTPUT_FILE = path.join(process.env.HOME, "diksha-automation", "diksha-diagnostic.txt");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

(async () => {
  console.log("Opening DIKSHA using profile:", PROFILE_DIR);
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
  if (page.url().includes("/auth/")) {
    console.log("Please log in normally in the browser window. Waiting up to 5 minutes...");
    await page.waitForFunction(() => !location.pathname.includes("/auth/"), { timeout: 300000 });
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const diagnostic = await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const describeElement = (el) => ({
      tag: el.tagName.toLowerCase(), text: clean(el.innerText).slice(0, 300),
      ariaLabel: el.getAttribute("aria-label") || "", title: el.getAttribute("title") || "",
      id: el.id || "", class: typeof el.className === "string" ? el.className : "",
      role: el.getAttribute("role") || "", href: el.getAttribute("href") || "",
      type: el.getAttribute("type") || "", visible: visible(el),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    });
    const buttons = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']")].map(describeElement);
    const links = [...document.querySelectorAll("a")].map(describeElement);
    const videos = [...document.querySelectorAll("video")].map((video) => ({
      src: video.currentSrc || video.src || "", duration: video.duration, currentTime: video.currentTime,
      paused: video.paused, ended: video.ended, autoplay: video.autoplay, controls: video.controls,
      muted: video.muted, width: video.videoWidth, height: video.videoHeight,
      class: video.className || "", id: video.id || "",
    }));
    const iframes = [...document.querySelectorAll("iframe")].map((frame) => ({
      src: frame.src || "", title: frame.title || "", name: frame.name || "", id: frame.id || "",
      class: typeof frame.className === "string" ? frame.className : "", visible: visible(frame),
    }));
    const keywords = /next|continue|complete|completed|finish|submit|mark|start|play|resume|assessment|quiz|certificate|proceed/i;
    const relevant = [...document.querySelectorAll("button, a, [role='button'], input, label")]
      .filter((el) => keywords.test([el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("value")].filter(Boolean).join(" ")))
      .map(describeElement);
    const videoRelated = [...document.querySelectorAll("[class*='video' i], [class*='player' i], [class*='media' i], [id*='video' i], [id*='player' i]")]
      .slice(0, 200).map(describeElement);
    return { pageText: clean(document.body.innerText).slice(0, 20000), buttons, links, videos, iframes, relevant, videoRelated };
  });

  const section = (title, items) => `${title}\n${"-".repeat(title.length)}\n${items.length ? items.map((item, index) => `\n[${index}] ${JSON.stringify(item, null, 2)}\n`).join("") : "(none)\n"}`;
  let output = "DIKSHA DIAGNOSTIC REPORT\n========================\n\n";
  output += `URL:\n${page.url()}\n\nTITLE:\n${await page.title()}\n\n`;
  output += `PAGE TEXT\n---------\n${diagnostic.pageText || "(none)"}\n\n`;
  output += section("BUTTONS", diagnostic.buttons) + "\n";
  output += section("RELEVANT CONTROLS", diagnostic.relevant) + "\n";
  output += section("LINKS", diagnostic.links) + "\n";
  output += section("VIDEOS", diagnostic.videos) + "\n";
  output += section("IFRAMES", diagnostic.iframes) + "\n";
  output += section("VIDEO / PLAYER RELATED ELEMENTS", diagnostic.videoRelated);
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, output, "utf8");
  console.log("Diagnostic complete. Report:", OUTPUT_FILE);
  console.log("Browser remains open. Press Ctrl+C here when finished.");
  await new Promise(() => {});
})().catch((error) => { console.error("Diagnostic failed:", error); process.exit(1); });
