const readline = require("readline");

// A fresh readline.Interface per question breaks after the second call on
// piped/non-TTY stdin — confirmed by testing: the process exits silently
// instead of reading further input. One shared interface, created lazily and
// reused for the life of the process, avoids that.
let rl = null;
function getInterface() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function ask(promptText) {
  return new Promise((resolve) => {
    getInterface().question(promptText, (answer) => resolve(answer.trim()));
  });
}

function closePrompt() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// Forces the shared interface to exist right now rather than on first ask().
// On a TTY, readline.createInterface puts stdin into raw/keypress mode as a
// side effect — the pause feature (Escape-to-pause) needs that active from
// the very start of the script, not just after the first prompt is shown.
function ensureInterface() {
  getInterface();
}

// Local copy of the course-id regex. Duplicated from lib/courses.js on purpose:
// courses.js requires this module, so requiring it back would be circular.
function courseId(url) {
  const m = /[?&]id=(\d+)/.exec(url || "");
  return m ? m[1] : null;
}

// Presents the three-way choice and returns "close" | "manual" | "retry".
// Loops on unrecognized input rather than defaulting to anything, since a
// wrong guess here (e.g. accidentally closing the app) is expensive to undo.
async function askChoice(title, detail) {
  console.log(`\n=== ${title} ===`);
  if (detail) console.log(detail);
  console.log("What would you like to do?");
  console.log("  1) Close the app");
  console.log("  2) Take over manually (leave the browser open for you)");
  console.log("  3) Retry");
  while (true) {
    const answer = await ask("Enter 1, 2, or 3: ");
    if (answer === "1") return "close";
    if (answer === "2") return "manual";
    if (answer === "3") return "retry";
    console.log("Please enter 1, 2, or 3.");
  }
}

async function waitForManualHandoff(instructions) {
  console.log(`\n${instructions || "The browser is yours — do whatever you need to manually."}`);
  await ask("Press Enter when you're ready to continue... ");
}

// Shows the choice menu, and if the user picks "manual", waits for their
// handoff then re-shows the same menu — so after finishing manual work they
// still get to pick close/retry, instead of the app guessing what's next.
async function resolveTrouble(title, detail, handoffInstructions) {
  while (true) {
    const choice = await askChoice(title, detail);
    if (choice === "manual") {
      await waitForManualHandoff(handoffInstructions);
      continue;
    }
    return choice;
  }
}

// The single course menu, used for both the startup picker and the
// "this course looks done" prompt. Never picks on its own — a choice always
// has to be typed.
//
// Returns one of:
//   { action: "switch", url, title }  — user picked a course (url may be relative)
//   { action: "stay" }                — only offered when allowStay is true
//   { action: "refresh" }             — caller should re-read the listing and call again
//   { action: "close" }
async function resolveCourseChoice(
  courses,
  { title = "Which course do you want to work on?", allowStay = false, currentId = null } = {}
) {
  while (true) {
    console.log(`\n=== ${title} ===`);
    if (!courses.length) {
      console.log("No enrolled courses were found on the 'My Learning' page.");
      console.log("Use 'u' to enter a course URL directly, or 'r' to re-read the page.");
    } else {
      console.log("Your enrolled courses:");
      courses.forEach((c, i) => {
        const marker = currentId && courseId(c.url) === currentId ? "   <- current" : "";
        console.log(`  ${i + 1}) ${c.title || c.url} — ${c.percent ?? "?"}% complete${marker}`);
      });
    }
    if (allowStay) console.log("  s) Stay on the current course");
    console.log("  r) Refresh this list");
    console.log("  u) Enter a course URL directly");
    console.log("  m) Take over manually (leave the browser open for you)");
    console.log("  c) Close the app");

    const answer = (await ask("Choice: ")).toLowerCase();
    if (answer === "c") return { action: "close" };
    if (answer === "r") return { action: "refresh" };
    if (allowStay && answer === "s") return { action: "stay" };
    if (answer === "u") {
      const url = await ask("Course URL: ");
      if (url) return { action: "switch", url, title: url };
      continue;
    }
    if (answer === "m") {
      await waitForManualHandoff("The browser is yours — do whatever you need to manually.");
      continue;
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= courses.length) {
      const chosen = courses[n - 1];
      return { action: "switch", url: chosen.url, title: chosen.title || chosen.url };
    }
    console.log("Didn't recognize that — try again.");
  }
}

// Back-compat wrapper for the end-of-course prompt.
async function resolveCourseSwitch(others, currentPercent) {
  return resolveCourseChoice(others, {
    title: `This course looks done (${currentPercent ?? "?"}% here) — what next?`,
    allowStay: true,
  });
}

module.exports = {
  askChoice, waitForManualHandoff, resolveTrouble,
  resolveCourseChoice, resolveCourseSwitch,
  ensureInterface, ask, closePrompt,
};
