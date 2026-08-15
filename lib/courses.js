const cfg = require("../config");
const { log } = require("./log");

const COURSE_LISTING_URL = "https://learning.diksha.gov.in/diksha/course_listing.php";

// Course cards on the "My Learning" page (confirmed live): each is a
// <span class="course-library-link" data-href="course.php?id=X&section=Y">
// wrapping a .library-card, with title in .course-detail h4 and an exact
// percentage in .progress-div span ("N% Completed"). No modeActive param is
// present or required — the course page picks a default section on its own,
// and this script's own module-expansion logic handles the rest regardless
// of which section that turns out to be.
async function listEnrolledCourses(page) {
  await page.goto(COURSE_LISTING_URL, { waitUntil: "domcontentloaded", timeout: cfg.NAV_TIMEOUT_MS });
  const deadline = Date.now() + cfg.NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => !!document.querySelector(".course-library-link[data-href]")).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const courses = await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll(".course-library-link[data-href]")].map((el) => {
      const href = el.getAttribute("data-href");
      const titleEl = el.querySelector(".course-detail h4");
      const percentEl = el.querySelector(".progress-div span");
      const m = percentEl ? /(\d+)\s*%/.exec(percentEl.textContent || "") : null;
      return {
        url: href,
        title: clean(titleEl ? titleEl.textContent : "").replace(/^Course Title\s*:\s*/i, ""),
        percent: m ? Number(m[1]) : null,
      };
    });
  }).catch((e) => {
    log("warn", "COURSES", `Could not read course listing: ${e.message}`);
    return [];
  });

  return courses;
}

// The default COURSE_URL carries a modeActive param the listing page's
// data-href never includes, so exact string comparison can't reliably tell
// whether a listed course is "the current one" — compare by the id= query
// param instead, which uniquely identifies a course regardless of section.
function extractCourseId(url) {
  const m = /[?&]id=(\d+)/.exec(url || "");
  return m ? m[1] : null;
}

module.exports = { listEnrolledCourses, extractCourseId, COURSE_LISTING_URL };
