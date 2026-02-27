import { spawn, type ChildProcess } from "child_process";
import { unlink } from "fs/promises";
import { logger } from "../logger.js";

const PLAYBACK_TIMEOUT = 300_000;

let activeChild: ChildProcess | null = null;
let activeFile: string | null = null;
let paused = false;

/**
 * Start playing an mp3 file in the background (non-blocking).
 * Returns immediately — use stopAudio/pauseAudio to control playback.
 * Cleans up the temp file when playback ends.
 */
export function playAudio(filePath: string): void {
  // Stop any existing playback first
  stopAudio();

  activeFile = filePath;
  paused = false;

  const cmd = process.platform === "darwin" ? "afplay" : "ffplay";
  const args = process.platform === "darwin"
    ? [filePath]
    : ["-nodisp", "-autoexit", filePath];

  const child = spawn(cmd, args, { stdio: "ignore" });
  activeChild = child;

  const timer = setTimeout(() => {
    child.kill();
    logger.warn("TTS playback timed out");
  }, PLAYBACK_TIMEOUT);

  const cleanup = () => {
    clearTimeout(timer);
    activeChild = null;
    activeFile = null;
    paused = false;
    unlink(filePath).catch(() => {});
  };

  child.on("close", (code) => {
    cleanup();
    if (code === 0 || code === null) {
      logger.info("TTS playback finished");
    } else {
      logger.warn(`TTS player exited with code ${code}`);
    }
  });

  child.on("error", (err) => {
    cleanup();
    logger.error(`TTS player error: ${err.message}`);
  });
}

/** Pause current playback (SIGSTOP). */
export function pauseAudio(): string {
  if (!activeChild) return "Nothing is playing.";
  if (paused) return "Already paused.";
  activeChild.kill("SIGSTOP");
  paused = true;
  logger.info("TTS playback paused");
  return "Playback paused.";
}

/** Resume paused playback (SIGCONT). */
export function resumeAudio(): string {
  if (!activeChild) return "Nothing is playing.";
  if (!paused) return "Already playing.";
  activeChild.kill("SIGCONT");
  paused = false;
  logger.info("TTS playback resumed");
  return "Playback resumed.";
}

/** Stop current playback immediately. */
export function stopAudio(): string {
  if (!activeChild) return "Nothing is playing.";
  // Resume first if paused, then kill — avoids zombie stopped process
  if (paused) activeChild.kill("SIGCONT");
  activeChild.kill();
  logger.info("TTS playback stopped");
  return "Playback stopped.";
}
