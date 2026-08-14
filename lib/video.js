const cfg = require("../config");
const { log } = require("./log");

async function findVideo(page) {
  for (const frame of page.frames()) {
    try {
      const handle = await frame.$("video");
      if (handle) return { frame, handle };
    } catch (_) { /* dead frame */ }
  }
  return null;
}

async function configureAndPlay(frame, handle) {
  const result = await frame.evaluate(async (video, rate) => {
    video.muted = true;
    video.playbackRate = rate;
    if (video.paused) {
      try { await video.play(); }
      catch (e) { return { ok: false, reason: e.name + ": " + e.message }; }
    }
    return { ok: true, duration: video.duration, rate: video.playbackRate };
  }, handle, cfg.PLAYBACK_RATE).catch((e) => ({ ok: false, reason: e.message }));

  if (!result.ok) { log("error", "VIDEO", `play() rejected — ${result.reason}`); return false; }
  if (result.rate !== cfg.PLAYBACK_RATE) {
    log("warn", "VIDEO", `Player reset playbackRate to ${result.rate}.`);
  }
  log("info", "VIDEO", `Playing (muted, ${result.rate}x, duration=${result.duration}).`);
  return true;
}

async function waitForVideoEnd(frame, handle) {
  let lastTime = -1;
  let lastProgressAt = Date.now();
  const hardDeadline = Date.now() + cfg.VIDEO_MAX_MS;

  while (Date.now() < hardDeadline) {
    const state = await frame.evaluate((v) => ({
      ended: v.ended,
      t: v.currentTime,
      d: v.duration,
      paused: v.paused,
      error: v.error ? v.error.code : null,
      ready: v.readyState,
    }), handle).catch(() => null);

    if (!state) return "detached";
    if (state.error) { log("error", "VIDEO", `MediaError code ${state.error}`); return "error"; }
    if (state.ended) return "ended";
    if (Number.isFinite(state.d) && state.d > 0 && state.t >= state.d - 0.5) return "ended";

    if (state.t > lastTime + 0.05) {
      lastTime = state.t;
      lastProgressAt = Date.now();
    } else if (state.paused) {
      log("debug", "VIDEO", "Unexpectedly paused; resuming.");
      await frame.evaluate((v) => v.play().catch(() => {}), handle).catch(() => {});
    }

    if (Date.now() - lastProgressAt > cfg.VIDEO_STALL_MS) return "stalled";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}

module.exports = { findVideo, configureAndPlay, waitForVideoEnd };
