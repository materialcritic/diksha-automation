const readline = require("readline");
const { log } = require("./log");
const { ensureInterface, ask, resolveTrouble } = require("./prompt");

let pauseRequested = false;
let installed = false;

// Escape pauses; Ctrl+C should still quit. Node's readline, on a TTY, puts
// stdin into raw mode as a side effect of being created — that's the
// mechanism this relies on (ensureInterface() forces it to exist from the
// very start, not just after the first prompt). Raw mode disables the
// terminal's own Ctrl+C -> SIGINT handling, so it's re-emitted manually here;
// confirmed necessary by testing, not assumed.
function install() {
  if (installed) return;
  installed = true;

  if (!process.stdin.isTTY) {
    log("debug", "PAUSE", "stdin is not a TTY; Escape-to-pause is unavailable in this environment.");
    return;
  }

  ensureInterface();
  readline.emitKeypressEvents(process.stdin);

  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    if (key.name === "escape") {
      pauseRequested = true;
      return;
    }
    if (key.ctrl && key.name === "c") {
      process.emit("SIGINT");
    }
  });
}

// Non-blocking: true at most once per Escape press, consumed by whichever
// checkpoint notices it first.
function consumePauseRequest() {
  if (pauseRequested) {
    pauseRequested = false;
    return true;
  }
  return false;
}

// Called from a checkpoint (main loop, video/PDF poll loops) once a pause has
// been detected. Blocks until the user is done — pressing Enter re-shows the
// standard close/manual/retry menu so "resume" always means an explicit
// choice, not an assumption about what should happen next.
async function pauseAndWaitForResume() {
  log("warn", "PAUSE", "Paused (Escape pressed).");
  await ask("Press Enter to see what to do next... ");
  return resolveTrouble(
    "Paused",
    "The automation is paused. Whatever was playing/reading in the browser keeps running as-is.",
    "The browser is yours — do whatever you need to manually."
  );
}

module.exports = { install, consumePauseRequest, pauseAndWaitForResume };
