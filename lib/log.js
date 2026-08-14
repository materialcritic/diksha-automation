const cfg = require("../config");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = { 0: "DEBUG", 1: "INFO", 2: "WARN", 3: "ERROR" };
const MIN_LEVEL = LEVELS[cfg.LOG_LEVEL] || 1;

function log(level, tag, message) {
  const levelNum = LEVELS[level] || 1;
  if (levelNum < MIN_LEVEL) return;

  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[levelNum];
  const line = `${timestamp} ${levelName.padEnd(5)} [${tag}] ${message}`;

  if (levelNum >= 2) {
    process.stderr.write(line + "\n");
  } else {
    console.log(line);
  }
}

module.exports = { log };
