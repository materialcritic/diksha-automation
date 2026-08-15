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

// Shows the current course's status plus other enrolled courses (with their
// real completion percentage, read live from "My Learning") and lets the
// user pick one to switch to, stay and retry the current course, take over
// manually, or close. Never switches on its own — a number has to be typed.
// `others` must already exclude the current course (course-id comparison,
// not URL string equality — the caller owns that logic).
async function resolveCourseSwitch(others, currentPercent) {
  while (true) {
    console.log(`\n=== This course looks done (${currentPercent ?? "?"}% here) — what next? ===`);
    if (others.length) {
      console.log("Your other enrolled courses:");
      others.forEach((c, i) => {
        console.log(`  ${i + 1}) ${c.title} — ${c.percent ?? "?"}% complete`);
      });
      console.log("  s) Stay here / retry this course");
    } else {
      console.log("No other enrolled courses were found.");
    }
    console.log("  m) Take over manually (leave the browser open for you)");
    console.log("  c) Close the app");
    console.log("  u) Enter a course URL directly");

    const answer = (await ask("Choice: ")).toLowerCase();
    if (answer === "c") return { action: "close" };
    if (answer === "s") return { action: "stay" };
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
    if (Number.isInteger(n) && n >= 1 && n <= others.length) {
      const chosen = others[n - 1];
      return { action: "switch", url: chosen.url, title: chosen.title };
    }
    console.log("Didn't recognize that — try again.");
  }
}

module.exports = {
  askChoice, waitForManualHandoff, resolveTrouble, resolveCourseSwitch,
  ensureInterface, ask, closePrompt,
};
