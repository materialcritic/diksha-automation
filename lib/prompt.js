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

module.exports = { askChoice, waitForManualHandoff, resolveTrouble, closePrompt };
