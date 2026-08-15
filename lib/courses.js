const cfg = require("../config");
const { log } = require("./log");
const { resolveCourseChoice } = require("./prompt");

const COURSE_LISTING_URL = cfg.COURSE_LISTING_URL;

// The listing page's data-href doesn't always carry the modeActive param the
// course URL does, so exact string comparison can't tell whether a listed
// course is "the current one" — compare by the id= query param instead,
// which uniquely identifies a course regardless of section.
function extractCourseId(url) {
  const m = /[?&]id=(\d+)/.exec(url || "");
  return m ? m[1] : null;
}

async function openCourseListing(page) {
  await page.goto(COURSE_LISTING_URL, {
    waitUntil: "domcontentloaded",
    timeout: cfg.NAV_TIMEOUT_MS,
  });
  const deadline = Date.now() + cfg.NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => !!document.querySelector(".course-library-link[data-href]"))
      .catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  log("warn", "COURSES", "Course listing did not render within the timeout.");
  return false;
}

// Course cards on the "My Learning" page (confirmed live): each is a
// <span class="course-library-link" data-href="...course.php?id=X&section=Y">
// wrapping a .library-card, with title in .course-detail h4 and an exact
// percentage in .progress-div span ("N% Completed"). The href was confirmed
// live to already be absolute, but resolving against location.href here is a
// harmless no-op in that case — page.goto() would otherwise reject a
// relative URL if this markup ever changes.
async function listEnrolledCourses(page) {
  await openCourseListing(page);

  const courses = await page
    .evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      return [...document.querySelectorAll(".course-library-link[data-href]")]
        .map((el) => {
          const href = el.getAttribute("data-href");
          const titleEl = el.querySelector(".course-detail h4");
          const percentEl = el.querySelector(".progress-div span");
          const m = percentEl ? /(\d+)\s*%/.exec(percentEl.textContent || "") : null;
          let url = "";
          try {
            url = new URL(href, location.href).href;
          } catch (e) {
            url = "";
          }
          return {
            url,
            title: clean(titleEl ? titleEl.textContent : "").replace(/^Course Title\s*:\s*/i, ""),
            percent: m ? Number(m[1]) : null,
          };
        })
        .filter((c) => c.url);
    })
    .catch((e) => {
      log("warn", "COURSES", `Could not read course listing: ${e.message}`);
      return [];
    });

  log("info", "COURSES", `Found ${courses.length} enrolled course(s).`);
  return courses;
}

// Opens "My Learning", shows the menu, and loops on "refresh" so the caller
// only ever sees a final decision. Note this NAVIGATES the page to the listing
// — the caller is responsible for going back to the course page afterwards.
async function chooseCourse(page, { title, allowStay = false, currentUrl = null } = {}) {
  const currentId = extractCourseId(currentUrl);
  let courses = await listEnrolledCourses(page).catch((err) => {
    log("warn", "COURSES", `Could not read course listing: ${err.message}`);
    return [];
  });

  while (true) {
    const choice = await resolveCourseChoice(courses, { title, allowStay, currentId });
    if (choice.action !== "refresh") return choice;
    courses = await listEnrolledCourses(page).catch(() => courses);
  }
}

module.exports = {
  listEnrolledCourses,
  openCourseListing,
  chooseCourse,
  extractCourseId,
  COURSE_LISTING_URL,
};
