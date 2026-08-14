const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const { log } = require("./log");

function loadProgress() {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.PROGRESS_FILE, "utf8"));
    return {
      completed: new Set(data.completed || []),
      failed: new Map(data.failed || []),
    };
  } catch (e) {
    if (e.code !== "ENOENT") log("warn", "PROGRESS", `Load failed: ${e.message}`);
    return { completed: new Set(), failed: new Map() };
  }
}

function saveProgress(state) {
  try {
    fs.mkdirSync(cfg.LOCAL_DIR, { recursive: true });
    const tmp = cfg.PROGRESS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      completed: [...state.completed],
      failed: [...state.failed],
      updatedAt: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, cfg.PROGRESS_FILE);
  } catch (e) {
    log("error", "PROGRESS", `Save failed: ${e.message}`);
  }
}

module.exports = { loadProgress, saveProgress };
